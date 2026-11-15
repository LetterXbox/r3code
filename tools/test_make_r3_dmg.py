from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch

from tools.make_r3_dmg import make_dmg


class DmgTest(unittest.TestCase):
    def test_rejects_ad_hoc_signatures_before_creating_dmg(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = root / "candidate.app"
            server = app / "Contents/Resources/r3-server"
            server.mkdir(parents=True)
            (server / "t3code").write_text("server")
            with (app / "Contents/Info.plist").open("wb") as stream:
                plistlib.dump({"CFBundleIdentifier": "com.jasonkneen.r3code"}, stream)
            with patch("tools.make_r3_dmg.subprocess.run") as run:
                run.return_value.stderr = "Signature=adhoc\nTeamIdentifier=not set\n"
                with self.assertRaisesRegex(ValueError, "Developer ID"):
                    make_dmg(app, root / "output.dmg")
            self.assertFalse((root / "output.dmg").exists())
            self.assertEqual(run.call_count, 2)


if __name__ == "__main__":
    unittest.main()
