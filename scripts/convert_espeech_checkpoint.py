#!/usr/bin/env python3
"""Convert the ESpeech-TTS-1 RL-V2 PyTorch checkpoint into an F5-TTS MLX bundle.

The checkpoint is a standard PyTorch zip archive whose tensors are read with a
pure `pickle`/`zipfile` reader — torch is not required. Tensors are mapped to
the key/shape conventions of speech-swift's F5TTSFlow (the same layout the
`aufklarer/F5TTS-v1-Base-MLX-fp16` bundle uses) and written as one safetensors
file. Vocos weights, the vocab and the F5 bundle config are copied from a
reference F5 MLX bundle because ESpeech is an F5-TTS v1 fine-tune and uses the
identical vocabulary and vocoder.

Usage:
  python3 convert_espeech_checkpoint.py \
      --checkpoint models/espeech/espeech_tts_rlv2.pt \
      --f5-bundle models/f5base \
      --out  models/espeech/ESpeech-TTS-1-RL-V2-MLX-fp16
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pickle
import shutil
import struct
import sys
import zipfile
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class StorageRef:
    key: str
    numel: int
    dtype: str


@dataclass
class TensorRef:
    storage: StorageRef
    offset: int
    size: tuple
    stride: tuple

    @property
    def numel(self) -> int:
        n = 1
        for s in self.size:
            n *= s
        return n


STORAGE_DTYPES = {
    "FloatStorage": "f4",
    "HalfStorage": "f2",
    "BFloat16Storage": "bf2",
    "DoubleStorage": "f8",
    "LongStorage": "i8",
    "IntStorage": "i4",
    "ShortStorage": "i2",
    "CharStorage": "i1",
    "ByteStorage": "u1",
    "BoolStorage": "b1",
}

SAFETENSORS_DTYPES = {"f4": "F32", "f2": "F16", "bf2": "BF16"}


class _PickleUnpickler(pickle.Unpickler):
    """Reads torch tensors from `data.pkl` without importing torch."""

    def __init__(self, file, storage_types: dict):
        super().__init__(file)
        self.storage_types = storage_types

    def find_class(self, module, name):
        if module == "torch._utils":
            if name in ("_rebuild_tensor_v2", "_rebuild_tensor"):
                return self._rebuild_tensor
            if name == "_rebuild_parameter":
                return self._rebuild_parameter
        if module == "torch" and name in STORAGE_DTYPES:
            holder = ("storage-class", name)
            self.storage_types[name] = holder
            return holder
        if module == "torch" and name == "DoubleTensor":
            return ("storage-class", "DoubleStorage")
        if module == "torch" and name == "FloatTensor":
            return ("storage-class", "FloatStorage")
        if module == "torch" and name == "HalfTensor":
            return ("storage-class", "HalfStorage")
        if module == "collections" and name == "OrderedDict":
            return OrderedDict
        if module == "torch" and name == "Size":
            return tuple
        return super().find_class(module, name)

    def persistent_load(self, pid):
        assert pid[0] == "storage", pid[0]
        storage_type, key, _location, numel = pid[1], pid[2], pid[3], pid[4]
        if isinstance(storage_type, tuple):
            dtype = STORAGE_DTYPES[storage_type[1]]
        else:
            dtype = STORAGE_DTYPES[storage_type.__name__]
        return StorageRef(key=str(key), numel=numel, dtype=dtype)

    # -- rebuild helpers -----------------------------------------------------
    def _rebuild_tensor(self, storage, offset, size, stride, *rest):
        return TensorRef(storage=storage, offset=offset, size=tuple(size), stride=tuple(stride))

    def _rebuild_parameter(self, data, requires_grad, hooks):
        return data


def read_state_dict(pt_path: Path) -> tuple[dict, list]:
    with zipfile.ZipFile(pt_path) as zf:
        names = zf.namelist()
        pkl_name = next(n for n in names if n.endswith("/data.pkl"))
        storage_types: dict = {}
        state = _PickleUnpickler(zf.open(pkl_name), storage_types).load()

        def find_tensor(node):
            found = []
            if isinstance(node, TensorRef):
                found.append(node)
            elif isinstance(node, dict):
                for value in node.values():
                    found.extend(find_tensor(value))
            elif isinstance(node, (list, tuple)):
                for value in node:
                    found.extend(find_tensor(value))
            return found

        # The state dict may be wrapped (ema_model_state_dict, model, ...).
        if not find_tensor(state):
            raise SystemExit("no tensors found in checkpoint")
        flat = {}

        def flatten(prefix, node):
            if isinstance(node, TensorRef):
                flat[prefix] = node
            elif isinstance(node, dict):
                for key, value in node.items():
                    flatten(f"{prefix}.{key}" if prefix else str(key), value)
            elif isinstance(node, (list, tuple)):
                for index, value in enumerate(node):
                    flatten(f"{prefix}.{index}" if prefix else str(index), value)

        flatten("", state)
        return flat, storage_types


def load_tensor(zf: zipfile.ZipFile, ref: TensorRef, archive_prefix: str) -> np.ndarray:
    dtype = np.dtype(ref.storage.dtype)
    entry = f"{archive_prefix}/data/{ref.storage.key}"
    raw = zf.read(entry)
    end = (ref.offset + ref.numel) * dtype.itemsize
    if end > len(raw):
        raise SystemExit(f"storage {entry} truncated: need {end}, have {len(raw)}")
    flat = np.frombuffer(raw, dtype=dtype, count=ref.numel, offset=ref.offset * dtype.itemsize)
    if all(s >= 0 for s in ref.stride):
        return np.lib.stride_tricks.as_strided(
            flat, shape=ref.size, strides=[s * dtype.itemsize for s in ref.stride]
        ).copy()
    # Negative strides cannot be expressed with as_strided; flip manually.
    arr = np.empty(ref.size, dtype=dtype)
    linear = 0
    for index in np.ndindex(ref.size):
        coords = [i if s >= 0 else (size - 1 - i) for i, size, s in zip(index, ref.size, ref.stride)]
        flat_index = sum(c * abs(s) for c, s in zip(coords, ref.stride))
        arr[index] = flat[flat_index]
    return arr


def convert_tensor(key: str, array: np.ndarray) -> tuple[str, np.ndarray] | None:
    """Map a raw checkpoint tensor to the F5 MLX bundle layout.

    Returns None to drop the tensor (`initted`, `step`, optimizer state).
    Kernel-1 Conv1d weights are folded into Linear weights, which is how the
    reference F5 bundle represents `input_embed.proj` ([out, in]).
    """
    if key.endswith("initted") or key == "step" or key.endswith(".step"):
        return None
    if key.endswith("input_embed.proj.weight") and array.ndim == 3 and array.shape[-1] == 1:
        return key, array.reshape(array.shape[0], array.shape[1])
    return key, array


def write_safetensors(path: Path, tensors: OrderedDict, metadata: dict | None = None) -> None:
    header: OrderedDict = OrderedDict()
    offset = 0
    for name, array in tensors.items():
        kind = array.dtype.str[1:]
        if kind not in SAFETENSORS_DTYPES:
            raise SystemExit(f"{name}: unsupported dtype {array.dtype}")
        dtype = SAFETENSORS_DTYPES[kind]
        byte_count = array.nbytes
        header[name] = {
            "dtype": dtype,
            "shape": list(array.shape),
            "data_offsets": [offset, offset + byte_count],
        }
        offset += byte_count
    if metadata is not None:
        header["__metadata__"] = metadata
    header_bytes = json.dumps(header, separators=(",", ":")).encode()
    padding = 8 - (len(header_bytes) % 8)
    header_bytes += b" " * padding
    with open(path, "wb") as handle:
        handle.write(struct.pack("<Q", len(header_bytes)))
        handle.write(header_bytes)
        for array in tensors.values():
            handle.write(memoryview(np.ascontiguousarray(array)).cast("B"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--f5-bundle", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--precision", choices=["fp16", "fp32"], default="fp16")
    parser.add_argument(
        "--weights",
        choices=["ema", "model"],
        default="ema",
        help="which wrapper to convert; ESpeech ships both (ema_model_state_dict / model_state_dict)",
    )
    args = parser.parse_args()

    flat, _storage_types = read_state_dict(args.checkpoint)
    archive_prefix = zipfile.ZipFile(args.checkpoint).namelist()[0].split("/")[0]
    # Finetune checkpoints wrap the DiT weights in one or two state dicts
    # (`ema_model_state_dict.ema_model.transformer...`,
    # `model_state_dict.transformer...`). Prefer the EMA weights — that is what
    # the F5 finetune inference path loads — and keep only `transformer.*`.
    wrappers = {k.split(".", 2)[0] for k in flat if ".transformer." in k}
    preference = (
        ["ema_model_state_dict", "model_state_dict"]
        if args.weights == "ema"
        else ["model_state_dict", "ema_model_state_dict"]
    )
    chosen = next((name for name in preference if name in wrappers), None)
    if chosen is None:
        raise SystemExit(f"cannot pick a transformer wrapper from {sorted(wrappers)}")
    normalized = {}
    for key, value in flat.items():
        if not key.startswith(chosen + "."):
            continue
        marker = ".transformer."
        if marker not in key:
            continue
        normalized[key[key.index(marker) + 1:]] = value
    flat = normalized
    if not flat:
        raise SystemExit(f"no transformer tensors under {chosen}")

    converted: OrderedDict = OrderedDict()
    skipped = []
    source_dtypes: dict[str, int] = {}
    with zipfile.ZipFile(args.checkpoint) as zf:
        for key, ref in flat.items():
            source_dtypes[ref.storage.dtype] = source_dtypes.get(ref.storage.dtype, 0) + 1
            array = load_tensor(zf, ref, archive_prefix)
            mapping = convert_tensor(key, array)
            if mapping is None:
                skipped.append(key)
                continue
            name, tensor = mapping
            if args.precision == "fp16":
                tensor = tensor.astype(np.float16)
            converted[name] = tensor

    transformer_keys = [k for k in converted if k.startswith("transformer.")]
    print(f"converted tensors: {len(converted)} (transformer: {len(transformer_keys)})")
    print(f"skipped: {skipped}")
    print(f"source dtype counts: {source_dtypes}")

    out_dir = args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    write_safetensors(out_dir / "model.safetensors", converted)

    # Vocoder, vocab and reference config come from the F5 base bundle; the
    # RL-V2 fine-tune changes only the DiT weights.
    for name in ("vocos.safetensors", "vocos_config.yaml", "vocab.txt"):
        shutil.copyfile(args.f5_bundle / name, out_dir / name)

    base_config = json.loads((args.f5_bundle / "config.json").read_text())
    config = dict(base_config)
    config["model_name"] = "ESpeech-TTS-1-RL-V2"
    config["source_repo"] = "ESpeech/ESpeech-TTS-1_RL-V2"
    config["source_checkpoint"] = "espeech_tts_rlv2.pt"
    config["license"] = "apache-2.0"
    config["commercial_use"] = True
    config["precision"] = args.precision
    config["conversion"] = {
        "f5": {
            "source_tensors": len(flat),
            "saved_tensors": len(converted),
            "skipped": skipped,
            "source_dtype_counts": {k.replace("f", "torch.float").replace("torch.float4", "torch.float32").replace("torch.float2", "torch.float16"): v for k, v in source_dtypes.items()},
            "size_mb": round((out_dir / "model.safetensors").stat().st_size / 1e6, 1),
        },
        # The vocoder is copied verbatim from the F5 bundle, not converted.
        "vocos": {"saved_tensors": 83, "size_mb": 25.9},
    }
    (out_dir / "config.json").write_text(json.dumps(config, indent=2) + "\n")
    print(f"bundle at {out_dir}: sha256(model)={sha256(out_dir / 'model.safetensors')[:16]}…")
    return 0


if __name__ == "__main__":
    sys.exit(main())
