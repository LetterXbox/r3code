import hashlib
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

from tools.stage_python_runtime import stage_runtime


class StagePythonRuntimeTest(unittest.TestCase):
    def make_archive(self, path, extra=None):
        with tarfile.open(path, "w:gz") as tar:
            for name in ("python/bin/python3.11", "python/lib/python3.11/LICENSE.txt"):
                item = tarfile.TarInfo(name)
                item.size = 1
                tar.addfile(item, io.BytesIO(b"x"))
            if extra:
                tar.addfile(extra)
        return {"archiveSha256": hashlib.sha256(path.read_bytes()).hexdigest()}

    def test_extracts_verified_runtime_and_rejects_wrong_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "runtime.tar.gz"
            metadata = self.make_archive(archive)
            self.assertTrue((stage_runtime(archive, root / "ok", metadata) / "bin/python3.11").is_file())
            with self.assertRaisesRegex(ValueError, "checksum"):
                stage_runtime(archive, root / "wrong", {"archiveSha256": "wrong"})

    def test_rejects_symlink_escape(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            link = tarfile.TarInfo("python/bin/escape")
            link.type = tarfile.SYMTYPE
            link.linkname = "../../outside"
            archive = root / "runtime.tar.gz"
            metadata = self.make_archive(archive, link)
            with self.assertRaisesRegex(ValueError, "unsafe link"):
                stage_runtime(archive, root / "out", metadata)


if __name__ == "__main__":
    unittest.main()
