import json
import os
import socket
import tempfile
import time
import unittest
from pathlib import Path

import desktop_browser_bridge as bridge


class BridgeTest(unittest.TestCase):
    def test_bootstrap_envelope_names_the_two_fds(self):
        fd = bridge.bootstrap_pipe(1234, "127.0.0.1", 7, 8)
        with os.fdopen(fd) as f:
            envelope = json.loads(f.readline())
        self.assertEqual(envelope["mode"], "desktop")
        self.assertEqual((envelope["desktopBrowserFd"], envelope["desktopBrowserControlFd"]), (7, 8))
        self.assertTrue(envelope["desktopBootstrapToken"])

    def test_only_a_host_with_0014_gets_the_pipes(self):
        d = Path(tempfile.mkdtemp())
        (d / "old").write_bytes(b"\0" * 10000 + b"webview.underSurface")
        (d / "new").write_bytes(b"\0" * (1 << 22) + b"desktopBrowser.supported")
        self.assertFalse(bridge.host_supports_bridge(d / "old"))
        self.assertTrue(bridge.host_supports_bridge(d / "new"))
        self.assertFalse(bridge.host_supports_bridge(d / "missing"))

    def test_relays_lines_both_ways(self):
        path = Path(tempfile.mkdtemp()) / "b.sock"
        relay = bridge.DesktopBrowserBridge(path)
        events_r, control_w = relay.server_fds()
        host = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        host.connect(str(path))
        time.sleep(0.1)
        host.sendall(b'{"type":"attached","threadId":"t","tabId":"a"}\n')
        self.assertEqual(os.read(events_r, 4096), b'{"type":"attached","threadId":"t","tabId":"a"}\n')
        os.write(control_w, b'{"type":"release","threadId":"t","tabId":"a"}\n')
        host.settimeout(2)
        self.assertEqual(host.recv(4096), b'{"type":"release","threadId":"t","tabId":"a"}\n')
        # A new server drops the host connection, so the host announces its tabs again.
        relay.server_fds()
        self.assertEqual(host.recv(4096), b"")
        relay.close()


if __name__ == "__main__":
    unittest.main()
