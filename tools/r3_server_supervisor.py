#!/usr/bin/env python3
"""Start a packaged T3 runtime for one R3 process, using private app-owned data.

The only stdout output is the path of a private one-use bootstrap file. The
credential itself is never printed or passed on a command line.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import stat
import subprocess
import time
import urllib.error
import urllib.request
import uuid


def private_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=False, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError(f"App-owned directory is not private: {path}")


def private_file(path: Path, flags: int) -> int:
    fd = os.open(path, flags | getattr(os, "O_NOFOLLOW", 0), 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        os.close(fd)
        raise RuntimeError("App-owned file is not private")
    return fd


def parent_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def serve(runtime: Path, data: Path, bootstrap_dir: Path, parent: int, *, timeout: float = 90) -> None:
    runtime = runtime.resolve(strict=True)
    if not runtime.is_file() or not os.access(runtime, os.X_OK):
        raise RuntimeError("Packaged server is not executable")
    if data.parent != bootstrap_dir.parent:
        raise RuntimeError("Server data and bootstrap must share an app-owned parent")
    private_directory(data.parent)
    private_directory(data)
    private_directory(bootstrap_dir)
    lock = private_file(data / "supervisor.lock", os.O_RDWR | os.O_CREAT)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock)
        raise RuntimeError("The app-owned local server is already running") from None
    server = None
    bootstrap = bootstrap_dir / f"bootstrap-{uuid.uuid4()}.json"
    try:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(("VITE_", "T3CODE_", "npm_", "PNPM_"))
               and key not in {"PORT", "NODE_PATH", "INIT_CWD", "NODE_PACKAGE_MANAGER"}}
        env["T3CODE_HOME"] = str(data)
        server = subprocess.Popen([str(runtime), "serve", "--mode", "desktop", "--host", "127.0.0.1", "--port", str(port), "--base-dir", str(data), "--no-browser"],
                                  cwd=runtime.parent, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if server.poll() is not None or not parent_alive(parent):
                raise RuntimeError("The local server exited before becoming ready")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/.well-known/t3/environment", timeout=0.5) as response:
                    if response.status == 200:
                        break
            except (OSError, urllib.error.URLError):
                time.sleep(0.2)
        else:
            raise RuntimeError("The local server did not become ready")
        result = subprocess.run([str(runtime), "auth", "pairing", "create", "--base-dir", str(data), "--ttl", "1h", "--label", "R3 Code", "--json"],
                                cwd=runtime.parent, env=env, capture_output=True, text=True, timeout=30, check=True)
        payload = json.loads(result.stdout)
        token = payload.get("credential") if isinstance(payload, dict) else None
        if not isinstance(token, str) or not token.strip():
            raise RuntimeError("The local server did not return a pairing credential")
        fd = private_file(bootstrap, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        with os.fdopen(fd, "w") as handle:
            json.dump({"endpoint": f"ws://127.0.0.1:{port}/ws", "token": token}, handle)
        print(bootstrap, flush=True)
        while parent_alive(parent) and server.poll() is None:
            time.sleep(0.5)
    finally:
        bootstrap.unlink(missing_ok=True)
        if server is not None and server.poll() is None:
            os.killpg(server.pid, signal.SIGTERM)
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(server.pid, signal.SIGKILL)
                server.wait()
        os.close(lock)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--bootstrap-dir", type=Path, required=True)
    parser.add_argument("--parent", type=int, required=True)
    args = parser.parse_args()
    def stop(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)
    try:
        serve(args.runtime, args.data_dir, args.bootstrap_dir, args.parent)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
