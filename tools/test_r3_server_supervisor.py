import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

from tools.r3_server_supervisor import private_directory, private_file

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("clang"), "Requires the macOS launcher toolchain")
class PackagedLauncherTest(unittest.TestCase):
    def compile_launcher(self, root, *, timeout_ms=120000):
        binaries = root / "MacOS"
        binaries.mkdir()
        launcher = binaries / "R3Code"
        subprocess.run(
            ["clang", "-Wall", "-Wextra", "-Werror", f"-DR3_BOOTSTRAP_TIMEOUT_MS={timeout_ms}",
             str(ROOT / "tools/r3_macos_launcher.c"),
             "-o", str(launcher)],
            check=True,
        )
        return launcher

    def run_launcher(self, launcher, host_script):
        host = launcher.parent / "nsh-gpui-host"
        host.write_text(host_script)
        host.chmod(0o755)
        env = dict(os.environ)
        for key in ("T3GPUI_BOOTSTRAP_FILE", "T3GPUI_CLI_HOME", "T3GPUI_CLI_ENTRY"):
            env.pop(key, None)
        return subprocess.run([str(launcher)], env=env, capture_output=True, text=True, timeout=5)

    def test_failed_server_bootstrap_still_launches_the_recovery_host(self):
        with tempfile.TemporaryDirectory() as temporary:
            launcher = self.compile_launcher(Path(temporary))
            result = self.run_launcher(
                launcher,
                '#!/bin/sh\ntest "$T3GPUI_LOCAL_STARTUP_FAILED" = 1 || exit 2\nprintf "recovery host reached\\n"\n',
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "recovery host reached\n")

    def test_successful_bootstrap_exposes_the_bundled_cli(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            launcher = self.compile_launcher(root)
            server = root / "Resources/r3-server/t3code"
            server.parent.mkdir(parents=True)
            server.write_text("#!/bin/sh\nexit 0\n")
            server.chmod(0o755)
            supervisor = launcher.parent / "r3-server-supervisor"
            supervisor.write_text('#!/bin/sh\nprintf "fixture-bootstrap.json\\n"\n')
            supervisor.chmod(0o755)
            result = self.run_launcher(
                launcher,
                '#!/bin/sh\ntest "$T3GPUI_BOOTSTRAP_FILE" = fixture-bootstrap.json && '
                'test "$T3GPUI_CLI_HOME" = "$HOME/.r3/server" && test -x "$T3GPUI_CLI_ENTRY"\n',
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_partial_bootstrap_output_cannot_extend_readiness_deadline(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            launcher = self.compile_launcher(root, timeout_ms=700)
            server = root / "Resources/r3-server/t3code"
            server.parent.mkdir(parents=True)
            server.write_text("#!/bin/sh\nexit 0\n")
            server.chmod(0o755)
            supervisor = launcher.parent / "r3-server-supervisor"
            supervisor.write_text(
                '#!/bin/sh\nprintf "fixture"\nsleep 0.3\nprintf "-"\nsleep 0.3\n'
                'printf "bootstrap"\nsleep 0.3\nprintf ".json\\n"\n'
            )
            supervisor.chmod(0o755)
            result = self.run_launcher(
                launcher,
                '#!/bin/sh\ntest "$T3GPUI_LOCAL_STARTUP_FAILED" = 1 && '
                'test -z "$T3GPUI_BOOTSTRAP_FILE"\n',
            )
            self.assertEqual(result.returncode, 0, result.stderr)


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


FAKE_RUNTIME = '''#!/usr/bin/env python3
import http.server, json, os, sys, uuid

def serve_cmd(args):
    port = int(args[args.index("--port") + 1])
    data = args[args.index("--base-dir") + 1]
    with open(os.path.join(data, "server.pid"), "w") as handle:
        handle.write(str(os.getpid()))
    with open(os.path.join(data, "server.path"), "w") as handle:
        handle.write(os.environ.get("PATH", ""))

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/.well-known/t3/environment":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"label": "R3 Code"}).encode())
            else:
                self.send_response(404)
                self.end_headers()

        def log_message(self, *_args):
            pass

    http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    if sys.argv[1] == "serve":
        serve_cmd(sys.argv)
    elif sys.argv[1] == "auth":
        print(json.dumps({"credential": str(uuid.uuid4())}))
'''


def _read_bootstrap(supervisor, bootstrap_path, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if supervisor.poll() is not None:
            raise AssertionError(f"Supervisor exited early (code {supervisor.returncode})")
        try:
            text = bootstrap_path.read_text()
            if text:
                return json.loads(text)
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    raise AssertionError("Bootstrap file never became readable")


@unittest.skipUnless(shutil.which("swiftc"), "Requires swiftc to compile the production supervisor")
class SwiftCrashRecoveryTest(unittest.TestCase):
    """Exercises the compiled Swift supervisor directly -- the Python mirror above has no restart logic, so
    these behaviors (H1 crash recovery, login-shell PATH capture) can only be verified against the real binary."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="r3-swift-supervisor-")
        cls.binary = Path(cls.tmp.name) / "r3-server-supervisor"
        subprocess.run(
            ["swiftc", "-O", "-target", "arm64-apple-macosx13.5", str(ROOT / "tools/r3_server_supervisor.swift"), "-o", str(cls.binary)],
            check=True, cwd=ROOT,
        )

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="r3-swift-case-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        runtime_dir = self.root / "runtime"
        runtime_dir.mkdir()
        self.runtime = runtime_dir / "t3code"
        self.runtime.write_text(FAKE_RUNTIME)
        self.runtime.chmod(0o755)
        self.data_dir = self.root / "data"
        self.bootstrap_dir = self.root / "bootstrap"
        self.bootstrap_path_glob = lambda: next(iter(sorted(self.bootstrap_dir.glob("bootstrap-*.json"))), None)
        self.parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        self.addCleanup(self._kill, self.parent)

    @staticmethod
    def _kill(proc):
        if proc.poll() is None:
            proc.kill()
            proc.wait()

    def _start_supervisor(self, env=None):
        command = [str(self.binary), "--runtime", str(self.runtime), "--data-dir", str(self.data_dir),
                   "--bootstrap-dir", str(self.bootstrap_dir), "--parent", str(self.parent.pid)]
        supervisor = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        self.addCleanup(self._kill, supervisor)
        return supervisor

    def test_restarts_the_server_on_the_same_port_with_a_fresh_token_after_a_crash(self):
        supervisor = self._start_supervisor()
        ready, _, _ = select.select([supervisor.stdout], [], [], 60)
        self.assertTrue(ready, "Supervisor did not publish a bootstrap path")
        bootstrap_path = Path(supervisor.stdout.readline().strip())
        first = json.loads(bootstrap_path.read_text())
        pid_file = self.data_dir / "server.pid"
        deadline = time.monotonic() + 20
        while not pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        first_pid = int(pid_file.read_text())
        os.kill(first_pid, 9)
        pid_file.unlink(missing_ok=True)

        deadline = time.monotonic() + 20
        second = None
        while time.monotonic() < deadline:
            try:
                candidate = json.loads(bootstrap_path.read_text())
            except (OSError, ValueError):
                candidate = None
            if candidate and candidate.get("token") != first["token"]:
                second = candidate
                break
            time.sleep(0.1)
        self.assertIsNotNone(second, "Supervisor never re-issued the bootstrap file after a crash")
        self.assertEqual(second["endpoint"], first["endpoint"], "Expected the same port to be reused once free")
        self.assertNotEqual(second["token"], first["token"])

        deadline = time.monotonic() + 20
        while not pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertTrue(pid_file.exists(), "A new server process never started")

    def test_parent_death_stops_the_server_without_a_restart(self):
        supervisor = self._start_supervisor()
        ready, _, _ = select.select([supervisor.stdout], [], [], 60)
        self.assertTrue(ready)
        bootstrap_path = Path(supervisor.stdout.readline().strip())
        self.assertTrue(bootstrap_path.is_file())
        self.parent.terminate()
        self.parent.wait(timeout=5)
        self.assertEqual(supervisor.wait(timeout=10), 0)
        self.assertFalse(bootstrap_path.exists())

    def test_sigterm_exits_cleanly_and_removes_the_bootstrap_file(self):
        supervisor = self._start_supervisor()
        ready, _, _ = select.select([supervisor.stdout], [], [], 60)
        self.assertTrue(ready)
        bootstrap_path = Path(supervisor.stdout.readline().strip())
        supervisor.terminate()
        self.assertEqual(supervisor.wait(timeout=10), 0)
        self.assertFalse(bootstrap_path.exists())

    def test_login_shell_path_is_merged_ahead_of_the_hardcoded_fallback(self):
        # A fake $SHELL that behaves like a real one invoked with the `-l -i -c <script>` / `-l -c <script>`
        # flag sets the supervisor tries (see shellAttemptFlagSets): it "loads rc files" (exports a PATH with a
        # marker directory prepended) unconditionally, then execs the `-c` script's payload, same shape as
        # zuse's `shell_env.rs` test fixtures (`RUN_PAYLOAD`).
        marker_bin = self.root / "marker-bin"
        marker_bin.mkdir()
        fake_shell = self.root / "fake-shell.sh"
        fake_shell.write_text(
            f'#!/bin/sh\nPATH="{marker_bin}:$PATH"; export PATH\n'
            'while [ "$#" -gt 0 ]; do\n  if [ "$1" = "-c" ]; then shift; exec /bin/sh -c "$1"; fi\n  shift\ndone\nexit 1\n'
        )
        fake_shell.chmod(0o755)
        env = os.environ.copy()
        env["SHELL"] = str(fake_shell)

        supervisor = self._start_supervisor(env=env)
        ready, _, _ = select.select([supervisor.stdout], [], [], 60)
        self.assertTrue(ready, "Supervisor did not publish a bootstrap path with a custom SHELL")
        bootstrap_path = Path(supervisor.stdout.readline().strip())
        path_file = self.data_dir / "server.path"
        deadline = time.monotonic() + 20
        while not path_file.exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertTrue(path_file.exists(), "Server never started long enough to record its PATH")
        server_path = path_file.read_text()
        self.assertIn(str(marker_bin), server_path, f"Login-shell PATH was not merged in: {server_path}")
        self.assertTrue(bootstrap_path.is_file())
        supervisor.terminate()
        supervisor.wait(timeout=10)

    def test_login_shell_path_capture_can_be_disabled(self):
        marker_bin = self.root / "marker-bin"
        marker_bin.mkdir()
        fake_shell = self.root / "fake-shell.sh"
        fake_shell.write_text(
            f'#!/bin/sh\nPATH="{marker_bin}:$PATH"; export PATH\n'
            'while [ "$#" -gt 0 ]; do\n  if [ "$1" = "-c" ]; then shift; exec /bin/sh -c "$1"; fi\n  shift\ndone\nexit 1\n'
        )
        fake_shell.chmod(0o755)
        env = os.environ.copy()
        env["SHELL"] = str(fake_shell)
        env["T3GPUI_NO_LOGIN_SHELL_PATH"] = "1"

        supervisor = self._start_supervisor(env=env)
        ready, _, _ = select.select([supervisor.stdout], [], [], 60)
        self.assertTrue(ready)
        Path(supervisor.stdout.readline().strip())
        path_file = self.data_dir / "server.path"
        deadline = time.monotonic() + 20
        while not path_file.exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertTrue(path_file.exists())
        self.assertNotIn(str(marker_bin), path_file.read_text(), "T3GPUI_NO_LOGIN_SHELL_PATH=1 should have skipped the shell snapshot")
        supervisor.terminate()
        supervisor.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
