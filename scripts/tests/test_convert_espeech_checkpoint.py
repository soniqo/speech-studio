import importlib.util
import io
import json
import os
import pickle
import shutil
import struct
import subprocess
import sys
import tempfile
import types
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import numpy as np

SOURCE = Path(__file__).resolve().parents[1] / "convert_espeech_checkpoint.py"
SPEC = importlib.util.spec_from_file_location("espeech_converter", SOURCE)
converter = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = converter
SPEC.loader.exec_module(converter)


def write_tensor_checkpoint(path, key="weight"):
    torch = types.ModuleType("torch")
    utils = types.ModuleType("torch._utils")
    storage_type = type("FloatStorage", (), {"__module__": "torch"})
    torch.FloatStorage = storage_type
    torch._utils = utils

    def rebuild(*args):
        raise AssertionError("the converter must supply its own tensor rebuilder")

    rebuild.__module__ = "torch._utils"
    rebuild.__name__ = rebuild.__qualname__ = "_rebuild_tensor_v2"
    utils._rebuild_tensor_v2 = rebuild
    storage = object()

    class Tensor:
        def __reduce__(self):
            return rebuild, (storage, 0, (2,), (1,), False, {})

    class Writer(pickle.Pickler):
        def persistent_id(self, value):
            if value is storage:
                return ("storage", storage_type, "0", "cpu", 2)
            return None

    with patch.dict(sys.modules, {"torch": torch, "torch._utils": utils}):
        output = io.BytesIO()
        Writer(output).dump({"model_state_dict": {key: Tensor()}})
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("archive/data.pkl", output.getvalue())
        archive.writestr("archive/data/0", np.array([1.5, -2.0], dtype=np.float32).tobytes())


class BundleConversionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.base = self.root / "f5-base"
        self.base.mkdir()
        config = Path(__file__).with_name("fixtures") / "f5-config.json"
        shutil.copyfile(config, self.base / "config.json")
        (self.base / "vocab.txt").write_text(" \r\n+\r\n\u0301\r\n\u0305\r\nа\r\nб\r\n", encoding="utf-8")
        (self.base / "vocos_config.yaml").write_text("sample_rate: 24000\n")
        converter.write_safetensors(self.base / "vocos.safetensors", {"fixture": np.ones(1, dtype=np.float32)})
        self.checkpoint = self.root / "checkpoint.pt"
        write_tensor_checkpoint(self.checkpoint, "transformer.fixture.weight")
        self.bundle = self.root / "espeech"

    def convert(self):
        result = subprocess.run([
            sys.executable, str(SOURCE), "--checkpoint", str(self.checkpoint),
            "--f5-bundle", str(self.base), "--out", str(self.bundle),
        ], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_cli_produces_a_complete_bundle_with_converted_weights(self):
        self.convert()
        self.assertIn("ESpeech-TTS-1 RL-V2", (self.bundle / "README.md").read_text())
        config = json.loads((self.bundle / "config.json").read_text())
        self.assertEqual(config["model_type"], "f5-tts")
        self.assertEqual(config["model_name"], "ESpeech-TTS-1-RL-V2")
        for name in ("vocos.safetensors", "vocos_config.yaml", "vocab.txt"):
            self.assertEqual((self.bundle / name).read_bytes(), (self.base / name).read_bytes())
        with (self.bundle / "model.safetensors").open("rb") as weights:
            header_length, = struct.unpack("<Q", weights.read(8))
            header = json.loads(weights.read(header_length))
            self.assertEqual(header["transformer.fixture.weight"]["dtype"], "F16")
            self.assertEqual(header["transformer.fixture.weight"]["shape"], [2])
            np.testing.assert_array_equal(np.frombuffer(weights.read(), dtype=np.float16), [1.5, -2.0])

    def test_converted_bundle_passes_the_consumed_swift_loader(self):
        source_root = os.environ.get("SPEECH_SWIFT_DIR")
        if not source_root:
            self.skipTest("Set SPEECH_SWIFT_DIR to validate against the consumed F5 bundle loader")
        loader = Path(source_root) / "Sources/F5TTS/F5TTSConfig.swift"
        self.assertTrue(loader.is_file(), f"F5 loader source not found: {loader}")
        compiler = shutil.which("swiftc")
        self.assertIsNotNone(compiler, "swiftc is required for the configured loader contract test")
        executable = self.root / "validate-f5-bundle"
        compiled = subprocess.run([
            compiler, str(loader), str(loader.with_name("F5TTSTokenizer.swift")),
            str(loader.with_name("F5TTSPinyin.swift")),
            str(Path(__file__).with_name("validate_f5_bundle.swift")),
            "-o", str(executable),
        ], capture_output=True, text=True, timeout=60)
        self.assertEqual(compiled.returncode, 0, compiled.stderr)
        self.convert()
        result = subprocess.run([str(executable), str(self.bundle)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        info = json.loads(result.stdout)
        self.assertEqual(info["modelName"], "ESpeech-TTS-1-RL-V2")
        self.assertEqual(info["sampleRate"], 24000)
        self.assertGreater(info["weightMemory"], 0)
        self.assertEqual(info["vocabularySize"], 6)
        self.assertEqual(info["russianTokens"], [4, 5, 1])
        for name in ("README.md", "vocos_config.yaml"):
            with self.subTest(missing=name):
                path = self.bundle / name
                content = path.read_bytes()
                path.unlink()
                rejected = subprocess.run([str(executable), str(self.bundle)], capture_output=True, text=True, timeout=10)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertIn(name, rejected.stderr)
                path.write_bytes(content)


class CheckpointTests(unittest.TestCase):
    def checkpoint(self, root, payload):
        path = root / "checkpoint.pt"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("archive/data.pkl", payload)
        return path

    def test_rejects_executable_globals_before_running_them(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sentinel = root / "sentinel.txt"

            class ExecutableCheckpoint:
                def __reduce__(self):
                    return eval, (f"__import__('pathlib').Path({str(sentinel)!r}).write_text('unexpected')",)

            path = self.checkpoint(root, pickle.dumps(ExecutableCheckpoint()))
            with self.assertRaisesRegex(pickle.UnpicklingError, "Unsupported checkpoint global"):
                converter.read_state_dict(path)
            self.assertFalse(sentinel.exists())

    def test_reads_a_tensor_checkpoint_without_torch(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.pt"
            write_tensor_checkpoint(path)
            tensors, _ = converter.read_state_dict(path)
            tensor = tensors["model_state_dict.weight"]
            self.assertIsInstance(tensor, converter.TensorRef)
            self.assertEqual(tensor.storage.dtype, "f4")
            self.assertEqual(tensor.size, (2,))

    def test_validates_strided_tensor_storage_before_copying(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.pt"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("archive/data/0", np.arange(6, dtype=np.float32).tobytes())
            storage = converter.StorageRef(key="0", numel=6, dtype="f4")
            with zipfile.ZipFile(path) as archive:
                valid = converter.TensorRef(storage=storage, offset=1, size=(2,), stride=(3,))
                np.testing.assert_array_equal(converter.load_tensor(archive, valid, "archive"), [1, 4])
                invalid = converter.TensorRef(storage=storage, offset=1, size=(2,), stride=(1000,))
                with self.assertRaisesRegex(SystemExit, "invalid tensor storage"):
                    converter.load_tensor(archive, invalid, "archive")


if __name__ == "__main__":
    unittest.main()
