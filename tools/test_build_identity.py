import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools.build_identity import build_identity


class BuildIdentityTest(unittest.TestCase):
    def test_build_identity_reads_release_and_host(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "r3"
            upstream = Path(temporary) / "t3"
            root.mkdir()
            (upstream / "apps/desktop").mkdir(parents=True)
            (root / "R3_VERSION").write_text("0.2.0\n")
            host = root / "host"
            host.write_bytes(b"host executable")
            (root / "third_party/nsh-host-combined-src/.git").mkdir(parents=True)
            (root / "t3-release.json").write_text(json.dumps({"tag": "v0.1.9", "version": "0.1.9", "commit": "a" * 40}))
            (upstream / "apps/desktop/package.json").write_text('{"version":"0.1.8"}')

            def git(repo, *args):
                if args[0] == "status": return ""
                if "refs/tags/v0.1.9^{commit}" in args: return "a" * 40
                return "b" * 9 if repo == root else "c" * 9

            with patch("tools.build_identity.git", side_effect=git):
                result = build_identity(root, upstream, host)
                self.assertEqual((result["r3Version"], result["officialT3Version"], result["officialT3Sha"]), ("0.2.0", "0.1.9", "a" * 9))
                self.assertEqual((result["referenceT3Version"], result["referenceT3Sha"]), ("0.1.8", "c" * 9))
                self.assertEqual(result["hostSourceShaAtPackaging"], "c" * 9)
                self.assertEqual(result["hostExecutableSha256"], hashlib.sha256(host.read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()
