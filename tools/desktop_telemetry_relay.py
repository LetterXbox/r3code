"""Desktop host telemetry relay, launcher side (reference: telemetry/DesktopTelemetryPublisher.ts).

t3ui/desktop/hostTelemetry.ts samples power/thermal/idle state from inside the sandboxed webview, which has
neither a file descriptor nor its own pid, so it cannot write server-rs's `desktopTelemetryFd` directly the way
the reference's Electron main process does. Instead it drops each sample as a file next to the app's bootstrap
file -- the same file-drop/poll contract `relaunchRequest.ts` uses for its own launcher hand-off:
`<bootstrapDir>/telemetry-sample.json`, written atomically (`.tmp` then renamed).

This module is the other half, mirroring `desktop_browser_bridge.py`'s shape: `DesktopTelemetryRelay` owns the
actual pipe server-rs reads (`desktopTelemetryFd` in the bootstrap envelope, server-rs/src/background_activity.rs
`ingest_desktop_telemetry`), and `take_sample` tails the drop file from run_local.py's main poll loop. Each
forwarded frame is the sandboxed webview's own message (already shaped to the wire format
`buildHostTelemetryMessage` builds, validated by `ingest_desktop_telemetry`) with `sequence` and `electronPid`
overwritten here: `sequence` because only the launcher sees every sample in order, and `electronPid` because only
the launcher has a pid to offer (its own, standing in for the reference's Electron main-process pid -- the
sandboxed webview's `process` module exposes none; see hostTelemetry.ts's module note). A lost or malformed
sample is simply skipped: the next one a few seconds later covers for it, same as a missed poll tick elsewhere in
this launcher.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

SAMPLE_FILE = "telemetry-sample.json"


def take_sample(bootstrap_dir: Path) -> dict | None:
    """Reads and removes the drop file hostTelemetry.ts's publisher writes, if one is waiting. `None` for a
    missing, mid-write (not yet renamed into place, so never partially read) or malformed file."""
    path = bootstrap_dir / SAMPLE_FILE
    try:
        text = path.read_text()
    except OSError:
        return None
    try:
        path.unlink()
    except OSError:
        pass
    try:
        parsed = json.loads(text)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        n = os.write(fd, view)
        view = view[n:]


class DesktopTelemetryRelay:
    """One pipe per server launch, matching `DesktopBrowserBridge.server_fds`'s shape: `fd_for_child` is the
    inheritable read end server-rs is spawned with (named `desktopTelemetryFd` in the bootstrap envelope); the
    write end stays here, closed when the relay is closed (a restarted server gets a fresh relay, same as the
    browser bridge gets fresh fds)."""

    def __init__(self, pipe=os.pipe):
        read_fd, write_fd = pipe()
        os.set_inheritable(read_fd, True)
        self.fd_for_child = read_fd
        self._write_fd = write_fd
        self._sequence = 0
        self._closed = False

    def forward(self, sample: dict, pid: int) -> None:
        """Overwrites `sequence`/`electronPid` on the sampled message and writes it as one newline-delimited JSON
        frame. Silently drops a write failure (a closed/broken pipe, e.g. mid-restart): the next sample a few
        seconds later either lands on a fresh relay or is dropped the same way."""
        if self._closed:
            return
        self._sequence += 1
        frame = {**sample, "sequence": self._sequence, "electronPid": pid}
        try:
            _write_all(self._write_fd, (json.dumps(frame) + "\n").encode())
        except OSError:
            pass

    def close_child_fd(self) -> None:
        """The parent's copy of the fd handed to the child; closed right after spawning, same as the browser
        bridge's fds (the child keeps its own copy via inheritance)."""
        try:
            os.close(self.fd_for_child)
        except OSError:
            pass

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            os.close(self._write_fd)
        except OSError:
            pass
