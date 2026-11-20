import json
import os
import tempfile
import unittest
from pathlib import Path

import desktop_telemetry_relay as relay


class TakeSampleTest(unittest.TestCase):
    def test_a_missing_file_is_none(self):
        d = Path(tempfile.mkdtemp())
        self.assertIsNone(relay.take_sample(d))

    def test_reads_and_removes_the_drop_file(self):
        d = Path(tempfile.mkdtemp())
        (d / relay.SAMPLE_FILE).write_text(json.dumps({"sampledAtUnixMs": 1, "power": {"onBattery": "false"}}))
        sample = relay.take_sample(d)
        self.assertEqual(sample["power"]["onBattery"], "false")
        self.assertFalse((d / relay.SAMPLE_FILE).exists())
        # Consumed once: a second poll with nothing new waiting is None, not a stale repeat.
        self.assertIsNone(relay.take_sample(d))

    def test_malformed_json_is_none_but_still_removed(self):
        d = Path(tempfile.mkdtemp())
        (d / relay.SAMPLE_FILE).write_text("{not json")
        self.assertIsNone(relay.take_sample(d))
        self.assertFalse((d / relay.SAMPLE_FILE).exists())

    def test_a_non_object_json_value_is_none(self):
        d = Path(tempfile.mkdtemp())
        (d / relay.SAMPLE_FILE).write_text("[1, 2, 3]")
        self.assertIsNone(relay.take_sample(d))


class DesktopTelemetryRelayTest(unittest.TestCase):
    def test_fd_for_child_is_a_fresh_inheritable_pipe_read_end(self):
        r = relay.DesktopTelemetryRelay()
        try:
            flags = os.get_inheritable(r.fd_for_child)
            self.assertTrue(flags)
        finally:
            r.close_child_fd()
            r.close()

    def test_forward_overwrites_sequence_and_electron_pid_and_assigns_increasing_sequence(self):
        r = relay.DesktopTelemetryRelay()
        try:
            r.forward({"version": 1, "type": "desktopTelemetry", "sequence": 0, "electronPid": 1, "power": {}}, 4242)
            r.forward({"version": 1, "type": "desktopTelemetry", "sequence": 0, "electronPid": 1, "power": {}}, 4242)
            raw = os.read(r.fd_for_child, 65536).decode()
        finally:
            r.close_child_fd()
            r.close()
        lines = [json.loads(line) for line in raw.splitlines() if line]
        self.assertEqual([line["sequence"] for line in lines], [1, 2])
        self.assertEqual([line["electronPid"] for line in lines], [4242, 4242])

    def test_forward_after_close_is_silently_dropped(self):
        r = relay.DesktopTelemetryRelay()
        r.close_child_fd()
        r.close()
        r.forward({"power": {}}, 1)  # must not raise

    def test_forward_survives_a_closed_read_end_broken_pipe(self):
        r = relay.DesktopTelemetryRelay()
        os.close(r.fd_for_child)  # simulate the child (and its fd copy) going away entirely
        r.forward({"power": {}}, 1)  # EPIPE on write; must not raise
        r.close()


if __name__ == "__main__":
    unittest.main()
