"""Desktop browser bridge, launcher side (reference: apps/desktop/src/backend/DesktopBackendManager.ts).

The reference desktop app spawns the server with two extra file descriptors, named in the bootstrap JSON as
`desktopBrowserFd` (desktop to server: attached / detached / shown / cdp events) and `desktopBrowserControlFd`
(server to desktop: cdp / release / pointer / turn commands), newline-delimited JSON
(packages/contracts/src/desktopBrowser.ts). Here the launcher owns those pipes and relays their lines to the GPUI
host over a Unix socket the host connects to (`T3GPUI_DESKTOP_BROWSER_SOCKET`, host patch 0014). One host connection
at a time; a new one replaces the old. A new server (restart) drops the host connection, so the host announces its
tabs again, as the reference's `announceAll` does for a new backend.

`T3GPUI_BRIDGE_LOG=<file>` appends every relayed line (direction + line) for protocol debugging.
"""
from __future__ import annotations

import json
import os
import secrets
import socket
import tempfile
import threading
from pathlib import Path


MARKER = b"desktopBrowser.supported"


def host_supports_bridge(binary) -> bool:
    """Only a host with patch 0014 binds web views to the server's browser. For any other host the launcher makes no
    pipes: the server would otherwise wait 10 s for every tab to attach before falling back to its own browser."""
    try:
        with open(binary, "rb") as f:
            tail = b""
            while chunk := f.read(1 << 22):
                if MARKER in tail + chunk:
                    return True
                tail = chunk[-len(MARKER):]
    except OSError:
        return False
    return False


def socket_path(data_name: str) -> Path:
    # sun_path is 104 bytes on macOS: keep it short.
    return Path(tempfile.gettempdir()) / f"t3gpui-browser-{data_name}.sock"


class DesktopBrowserBridge:
    def __init__(self, path: Path, log_path: str | None = None):
        self.path = Path(path)
        self._lock = threading.Lock()
        self._conn: socket.socket | None = None
        self._events_w: int | None = None  # we write events for the server
        self._log = open(log_path, "a", buffering=1) if log_path else None
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass
        self._server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._server.bind(str(self.path))
        os.chmod(self.path, 0o600)
        self._server.listen(4)
        threading.Thread(target=self._accept, daemon=True).start()

    def _trace(self, direction: str, line: bytes) -> None:
        if self._log:
            try:
                self._log.write(f"{direction} {line.decode('utf-8', 'replace').rstrip()}\n")
            except Exception:
                pass

    def _accept(self) -> None:
        while True:
            try:
                conn, _ = self._server.accept()
            except OSError:
                return
            with self._lock:
                old, self._conn = self._conn, conn
            if old:
                try:
                    old.close()
                except OSError:
                    pass
            threading.Thread(target=self._from_host, args=(conn,), daemon=True).start()

    def _from_host(self, conn: socket.socket) -> None:
        buffer = b""
        while True:
            try:
                chunk = conn.recv(1 << 16)
            except OSError:
                break
            if not chunk:
                break
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if not line.strip():
                    continue
                self._trace(">", line)
                with self._lock:
                    fd = self._events_w
                if fd is not None:
                    try:
                        _write_all(fd, line + b"\n")
                    except OSError:
                        pass
        with self._lock:
            if self._conn is conn:
                self._conn = None

    def _from_server(self, fd: int) -> None:
        with os.fdopen(fd, "rb", buffering=0) as stream:
            buffer = b""
            while True:
                try:
                    chunk = stream.read(1 << 16)
                except OSError:
                    break
                if not chunk:
                    break
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if not line.strip():
                        continue
                    self._trace("<", line)
                    with self._lock:
                        conn = self._conn
                    if conn is not None:
                        try:
                            conn.sendall(line + b"\n")
                        except OSError:
                            pass

    def server_fds(self) -> tuple[int, int]:
        """New pipes for a new server: returns (events read end, control write end), both inheritable, for the
        child. The caller closes them in the parent after spawning."""
        events_r, events_w = os.pipe()
        control_r, control_w = os.pipe()
        os.set_inheritable(events_r, True)
        os.set_inheritable(control_w, True)
        with self._lock:
            old, self._events_w = self._events_w, events_w
            conn, self._conn = self._conn, None
        if old is not None:
            try:
                os.close(old)
            except OSError:
                pass
        if conn is not None:  # the host announces its tabs again to the new server
            try:
                conn.close()
            except OSError:
                pass
        threading.Thread(target=self._from_server, args=(control_r,), daemon=True).start()
        return events_r, control_w

    def close(self) -> None:
        try:
            self._server.close()
            self.path.unlink()
        except OSError:
            pass


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        n = os.write(fd, view)
        view = view[n:]


def bootstrap_pipe(port: int, host: str, events_fd: int | None = None, control_fd: int | None = None,
                    telemetry_fd: int | None = None) -> int:
    """A pipe holding one DesktopBackendBootstrap line (packages/contracts/src/desktopBootstrap.ts) for
    T3CODE_BOOTSTRAP_FD. The launcher's own port, host and --no-browser flags take precedence over the envelope's
    (and, when the browser bridge is active, its `--mode web` CLI arg overrides the envelope's `mode` too); this
    just carries whichever extra fds the caller has for this launch -- the browser bridge's two
    (`desktopBrowserFd`/`desktopBrowserControlFd`, tools/desktop_browser_bridge.py) and/or the host telemetry
    relay's one (`desktopTelemetryFd`, tools/desktop_telemetry_relay.py; server-rs/src/bootstrap.rs reads it into
    `config.desktop_telemetry_fd`). A fd argument left `None` is simply omitted from the envelope."""
    envelope = {
        "mode": "desktop",
        "noBrowser": True,
        "port": port,
        "host": host,
        "desktopBootstrapToken": secrets.token_urlsafe(24),
        "tailscaleServeEnabled": False,
        "tailscaleServePort": 443,
    }
    if events_fd is not None:
        envelope["desktopBrowserFd"] = events_fd
    if control_fd is not None:
        envelope["desktopBrowserControlFd"] = control_fd
    if telemetry_fd is not None:
        envelope["desktopTelemetryFd"] = telemetry_fd
    r, w = os.pipe()
    os.write(w, (json.dumps(envelope) + "\n").encode())
    os.close(w)
    os.set_inheritable(r, True)
    return r
