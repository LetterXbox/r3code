from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools.install_r3_local import install


class InstallR3Test(unittest.TestCase):
    def test_can_preserve_the_existing_r3code_bundle_name(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            applications = root / "Applications"
            applications.mkdir()
            candidate = root / "candidate.app/Contents"
            candidate.mkdir(parents=True)
            (candidate / "Info.plist").write_text("new")
            previous = applications / "R3Code.app/Contents"
            previous.mkdir(parents=True)
            (previous / "Info.plist").write_text("old")
            with patch("tools.install_r3_local.subprocess.run"), patch("tools.install_r3_local.subprocess.check_output", return_value=""):
                installed, backup = install(candidate.parent, applications, name="R3Code.app")
            self.assertEqual(installed.name, "R3Code.app")
            self.assertEqual((backup / "Contents/Info.plist").read_text(), "old")

    def test_replaces_app_and_keeps_previous_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            applications = root / "Applications"
            applications.mkdir()
            candidate = root / "candidate.app/Contents"
            candidate.mkdir(parents=True)
            (candidate / "Info.plist").write_text("new")
            previous = applications / "R3Code.app/Contents"
            previous.mkdir(parents=True)
            (previous / "Info.plist").write_text("old")
            with patch("tools.install_r3_local.subprocess.run"), patch("tools.install_r3_local.subprocess.check_output", return_value=""):
                installed, backup = install(candidate.parent, applications)
            self.assertEqual(installed.name, "R3 Code.app")
            self.assertFalse((applications / "R3Code.app").exists())
            self.assertEqual((installed / "Contents/Info.plist").read_text(), "new")
            self.assertEqual((backup / "Contents/Info.plist").read_text(), "old")

    def test_running_app_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            applications = root / "Applications"
            applications.mkdir()
            candidate = root / "candidate.app/Contents"
            candidate.mkdir(parents=True)
            (candidate / "Info.plist").write_text("new")
            previous = applications / "R3Code.app/Contents"
            previous.mkdir(parents=True)
            (previous / "Info.plist").write_text("old")
            running = str(previous.resolve() / "MacOS/nsh-gpui-host") + " --bundle x\n"
            with patch("tools.install_r3_local.subprocess.run"), patch("tools.install_r3_local.subprocess.check_output", return_value=running):
                with self.assertRaisesRegex(RuntimeError, "running"):
                    install(candidate.parent, applications)
            self.assertEqual((previous / "Info.plist").read_text(), "old")


if __name__ == "__main__":
    unittest.main()
