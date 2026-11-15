"""Exercise the launcher with a fake host; never launch the R3 app."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request


class BundledThemeRuntimeTest(unittest.TestCase):
    def test_launcher_uses_bundled_python_with_isolated_flags(self):
        with tempfile.TemporaryDirectory(prefix="r3-theme-launcher-") as temporary:
            root = Path(temporary)
            macos = root / "Contents/MacOS"
            resources = root / "Contents/Resources"
            macos.mkdir(parents=True)
            python = resources / "python/bin/python3.11"
            python.parent.mkdir(parents=True)
            python.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/python-args"\n')
            python.chmod(0o755)
            host = macos / "nsh-gpui-host"
            host.write_text('#!/bin/sh\ni=0\nwhile [ ! -f "$HOME/python-args" ] && [ "$i" -lt 40 ]; do /bin/sleep 0.05; i=$((i+1)); done\ntest -f "$HOME/python-args"\n')
            host.chmod(0o755)
            subprocess.run(["clang", "-O2", "-Wall", "-Wextra", "-Werror", "tools/r3_macos_launcher.c", "-o", str(macos / "launcher-fixture")], check=True)
            env = os.environ.copy()
            env.update({"HOME": str(root), "T3GPUI_BOOTSTRAP_FILE": "/unused"})
            subprocess.run([str(macos / "launcher-fixture")], env=env, check=True, capture_output=True, timeout=10)
            args = (root / "python-args").read_text().splitlines()
            self.assertEqual(args[:3], ["-I", "-S", "-B"])
            self.assertTrue(args[3].endswith("/Resources/theme/r3_theme_supervisor.py"))


@unittest.skipUnless(os.environ.get("R3_TEST_SUPERVISOR") and (os.environ.get("R3_TEST_SERVER") or os.environ.get("R3_TEST_RUNTIME")), "Requires isolated packaged Rust server and supervisor")
class LauncherServerTest(unittest.TestCase):
    def test_launcher_bootstraps_fake_host_and_stops_its_server(self):
        with tempfile.TemporaryDirectory(prefix="r3-launcher-fixture-") as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir(mode=0o700)
            macos = root / "Contents/MacOS"
            resources = root / "Contents/Resources"
            macos.mkdir(parents=True)
            (resources / "theme").mkdir(parents=True)
            (resources / "nsh").mkdir()
            (resources / "r3-server").mkdir()
            runtime_env = Path(os.environ.get("R3_TEST_SERVER") or os.environ["R3_TEST_RUNTIME"]).resolve()
            server_bin = runtime_env if runtime_env.is_file() else runtime_env / "t3code"
            (resources / "r3-server/t3code").symlink_to(server_bin)
            (resources / "theme/r3_theme_supervisor.py").write_text("pass\n")
            shutil.copy2(os.environ["R3_TEST_SUPERVISOR"], macos / "r3-server-supervisor")
            subprocess.run(["clang", "-O2", "-Wall", "-Wextra", "-Werror", "tools/r3_macos_launcher.c", "-o", str(macos / "launcher-fixture")], check=True)
            fake_host = macos / "nsh-gpui-host"
            fake_host.write_text("""#!/usr/bin/python3
import json, os, pathlib
p = pathlib.Path(os.environ['T3GPUI_BOOTSTRAP_FILE'])
assert p.stat().st_mode & 0o777 == 0o600
value = json.loads(p.read_text())
assert value['token'] and value['endpoint'].startswith('ws://127.0.0.1:')
assert value.get('serverEngine') == 'r3'
pathlib.Path(os.environ['HOME'], 'result.json').write_text(json.dumps({'endpoint': value['endpoint']}))
p.unlink()
""")
            fake_host.chmod(0o755)
            env = os.environ.copy()
            env["HOME"] = str(home)
            env.pop("T3GPUI_BOOTSTRAP_FILE", None)
            result = subprocess.run([str(macos / "launcher-fixture")], env=env, capture_output=True, text=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((home / ".r3/server").is_dir())
            endpoint = json.loads((home / "result.json").read_text())["endpoint"]
            origin = endpoint.replace("ws://", "http://").removesuffix("/ws")
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                try:
                    urllib.request.urlopen(origin, timeout=0.3).close()
                except (OSError, urllib.error.URLError):
                    break
                time.sleep(0.2)
            else:
                self.fail("Server remained available after the fake host exited")


if __name__ == "__main__":
    unittest.main()
