import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import unittest

from tools.r3_server_supervisor import private_directory, private_file


class PrivateStateTest(unittest.TestCase):
    def test_private_directories_and_files_reject_insecure_existing_permissions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state = root / "state"
            private_directory(state)
            fd = private_file(state / "lock", os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            self.assertEqual((state / "lock").stat().st_mode & 0o777, 0o600)
            state.chmod(0o755)
            with self.assertRaisesRegex(RuntimeError, "not private"):
                private_directory(state)

    def test_symlink_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "target").write_text("x")
            (root / "link").symlink_to(root / "target")
            with self.assertRaises(OSError):
                private_file(root / "link", os.O_RDONLY)


@unittest.skipUnless(os.environ.get("R3_TEST_SERVER"), "Set R3_TEST_SERVER to a built R3 Rust server binary")
class RuntimeTest(unittest.TestCase):
    def test_runtime_rejects_insecure_state_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            root.chmod(0o755)
            binary = os.environ.get("R3_TEST_SUPERVISOR")
            prefix = [binary] if binary else [sys.executable, "-m", "tools.r3_server_supervisor"]
            result = subprocess.run([*prefix, "--runtime", os.environ["R3_TEST_SERVER"], "--data-dir", str(root / "data"),
                                     "--bootstrap-dir", str(root / "bootstrap"), "--parent", str(os.getpid())],
                                    capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("not private", result.stderr)
            self.assertFalse((root / "data").exists())

    def test_runtime_rejects_symlink_lock(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = root / "data"
            data.mkdir(mode=0o700)
            (data / "supervisor.lock").symlink_to(root / "target")
            binary = os.environ.get("R3_TEST_SUPERVISOR")
            prefix = [binary] if binary else [sys.executable, "-m", "tools.r3_server_supervisor"]
            result = subprocess.run([*prefix, "--runtime", os.environ["R3_TEST_SERVER"], "--data-dir", str(data),
                                     "--bootstrap-dir", str(root / "bootstrap"), "--parent", str(os.getpid())],
                                    capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / "target").exists())

    def test_isolated_server_bootstrap_lock_and_parent_shutdown(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
            supervisor_binary = os.environ.get("R3_TEST_SUPERVISOR")
            prefix = [supervisor_binary] if supervisor_binary else [sys.executable, "-m", "tools.r3_server_supervisor"]
            command = [*prefix, "--runtime", os.environ["R3_TEST_SERVER"],
                       "--data-dir", str(root / "data"), "--bootstrap-dir", str(root / "bootstrap"), "--parent", str(parent.pid)]
            supervisor = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                ready, _, _ = select.select([supervisor.stdout], [], [], 60)
                self.assertTrue(ready, "Supervisor did not publish a bootstrap path")
                line = supervisor.stdout.readline().strip()
                bootstrap = Path(line)
                self.assertEqual(bootstrap.parent, root / "bootstrap")
                self.assertEqual(bootstrap.stat().st_mode & 0o777, 0o600)
                payload = json.loads(bootstrap.read_text())
                self.assertTrue(payload["endpoint"].startswith("ws://127.0.0.1:"))
                self.assertTrue(payload["token"])
                self.assertNotIn(payload["token"], line)
                if supervisor_binary:
                    self.assertEqual(payload.get("serverEngine"), "r3")
                import urllib.parse
                import urllib.request
                origin = payload["endpoint"].replace("ws://", "http://").removesuffix("/ws")
                with urllib.request.urlopen(origin + "/.well-known/t3/environment") as response:
                    descriptor = json.load(response)
                    if supervisor_binary:
                        self.assertEqual(descriptor.get("label"), "R3 Code")
                exchange = urllib.request.Request(origin + "/oauth/token", data=urllib.parse.urlencode({
                    "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
                    "subject_token": payload["token"],
                    "subject_token_type": "urn:t3:params:oauth:token-type:environment-bootstrap",
                    "requested_token_type": "urn:ietf:params:oauth:token-type:access_token",
                    "client_label": "R3 connection regression", "client_device_type": "desktop",
                }).encode())
                with urllib.request.urlopen(exchange) as response:
                    bearer = json.load(response)["access_token"]
                with urllib.request.urlopen(urllib.request.Request(origin + "/api/auth/session", headers={"Authorization": "Bearer " + bearer})) as response:
                    self.assertTrue(json.load(response)["authenticated"])
                if supervisor_binary:
                    with urllib.request.urlopen(urllib.request.Request(origin + "/api/voice/status", headers={"Authorization": "Bearer " + bearer})) as response:
                        voice_status = json.load(response)
                        self.assertTrue(voice_status["supported"], f"Expected local voice support, got: {voice_status}")
                duplicate = subprocess.run(command, capture_output=True, text=True, timeout=15)
                self.assertNotEqual(duplicate.returncode, 0)
                self.assertIn("already running", duplicate.stderr)
                parent.terminate()
                parent.wait(timeout=5)
                self.assertEqual(supervisor.wait(timeout=10), 0)
                self.assertFalse(bootstrap.exists())
                # A launcher startup failure terminates the supervisor directly;
                # it must release the data lock and remove its one-use file too.
                supervisor.stdout.close()
                supervisor.stderr.close()
                parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
                command[-1] = str(parent.pid)
                supervisor = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                ready, _, _ = select.select([supervisor.stdout], [], [], 60)
                self.assertTrue(ready, "Supervisor did not restart after shutdown")
                second_bootstrap = Path(supervisor.stdout.readline().strip())
                self.assertTrue(second_bootstrap.is_file())
                supervisor.terminate()
                self.assertEqual(supervisor.wait(timeout=12), 0)
                self.assertFalse(second_bootstrap.exists())
            finally:
                if parent.poll() is None:
                    parent.kill()
                    parent.wait()
                if supervisor.poll() is None:
                    supervisor.kill()
                    supervisor.wait()
                if supervisor.stdout:
                    supervisor.stdout.close()
                if supervisor.stderr:
                    supervisor.stderr.close()


if __name__ == "__main__":
    unittest.main()
