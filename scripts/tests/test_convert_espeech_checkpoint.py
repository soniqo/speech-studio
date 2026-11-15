import importlib.util
import io
import pickle
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
            Writer(output).dump({"model_state_dict": {"weight": Tensor()}})
        with tempfile.TemporaryDirectory() as directory:
            path = self.checkpoint(Path(directory), output.getvalue())
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
