from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch

from tools.sign_r3_candidate import sign_candidate


class SignCandidateTest(unittest.TestCase):
    def test_signs_host_supervisor_rust_server_and_bundle(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = root / "source.app"
            binaries = app / "Contents/MacOS"
            binaries.mkdir(parents=True)
            server = app / "Contents/Resources/r3-server"
            server.mkdir(parents=True)
            python = app / "Contents/Resources/python/bin"
            python.mkdir(parents=True)
            (python / "python3.11").write_bytes(b"\xcf\xfa\xed\xfebinary")
            for path in (binaries / "nsh-gpui-host", binaries / "r3-server-supervisor", server / "t3code"):
                path.write_bytes(b"test")
            with (app / "Contents/Info.plist").open("wb") as stream:
                plistlib.dump({"CFBundleIdentifier": "com.jasonkneen.r3code"}, stream)
            with patch("tools.sign_r3_candidate.subprocess.run") as run:
                sign_candidate(app, root / "signed.app", "Developer ID Application: Example")
            commands = [call.args[0] for call in run.call_args_list]
            self.assertEqual(len(commands), 6)
            self.assertTrue(commands[0][-1].endswith("nsh-gpui-host"))
            self.assertIn("--entitlements", commands[0])
            self.assertTrue(commands[1][-1].endswith("r3-server-supervisor"))
            self.assertTrue(commands[2][-1].endswith("/r3-server/t3code"))
            self.assertTrue(commands[3][-1].endswith("/python/bin/python3.11"))
            self.assertTrue((root / "signed.app/Contents/Resources/r3-server/t3code").is_file())

    def test_signs_bundled_speech_native_binaries(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = root / "source.app"
            binaries = app / "Contents/MacOS"
            binaries.mkdir(parents=True)
            server = app / "Contents/Resources/r3-server"
            speech_lib = server / "node_modules/@transcribe-cpp/darwin-arm64-metal"
            speech_lib.mkdir(parents=True)
            (speech_lib / "libtranscribe.dylib").write_bytes(b"\xcf\xfa\xed\xfedylib")
            for path in (binaries / "nsh-gpui-host", binaries / "r3-server-supervisor", server / "t3code"):
                path.write_bytes(b"test")
            with (app / "Contents/Info.plist").open("wb") as stream:
                plistlib.dump({"CFBundleIdentifier": "com.jasonkneen.r3code"}, stream)
            with patch("tools.sign_r3_candidate.subprocess.run") as run:
                sign_candidate(app, root / "signed.app", "Developer ID Application: Example")
            commands = [call.args[0] for call in run.call_args_list]
            self.assertTrue(any(cmd[-1].endswith("/libtranscribe.dylib") for cmd in commands))


if __name__ == "__main__":
    unittest.main()
