import json
from pathlib import Path
import tempfile
import unittest

from tools import server_exposure as se

IFCONFIG = """lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\tinet 127.0.0.1 netmask 0xff000000
bridge100: flags=8863<UP> mtu 1500
\tinet 192.168.64.1 netmask 0xffffff00
en0: flags=8863<UP,BROADCAST> mtu 1500
\tinet 192.168.4.33 netmask 0xffffff00 broadcast 192.168.4.255
utun4: flags=8051<UP> mtu 1280
\tinet 100.95.103.5 --> 100.95.103.5 netmask 0xffffffff
"""


class ServerExposureTest(unittest.TestCase):
    def test_lan_host_skips_loopback_bridges_and_tailnet(self):
        addresses = se.parse_ifconfig(IFCONFIG)
        self.assertEqual(addresses[0], ("lo0", "127.0.0.1"))
        self.assertEqual(se.resolve_lan_host(addresses), "192.168.4.33")
        self.assertEqual(se.resolve_lan_host([("bridge100", "192.168.64.1")]), "192.168.64.1")
        self.assertIsNone(se.resolve_lan_host([("utun4", "100.95.103.5")]))

    def test_state_local_only_and_network(self):
        addresses = se.parse_ifconfig(IFCONFIG)
        local = se.resolve_state({"mode": "local-only", "tailscaleServeEnabled": False, "tailscaleServePort": 443}, 5000, addresses, None)
        self.assertEqual(local["serverExposureState"], {"mode": "local-only", "endpointUrl": None, "advertisedHost": None, "tailscaleServeEnabled": False, "tailscaleServePort": 443})
        self.assertEqual([e["label"] for e in local["advertisedEndpoints"]], ["This machine"])
        ts = {"magicDnsName": "box.tail.ts.net", "tailnetIpv4Addresses": ["100.95.103.5"]}
        net = se.resolve_state({"mode": "network-accessible", "tailscaleServeEnabled": False, "tailscaleServePort": 443}, 5000, addresses, ts, probe=lambda _u: True)
        self.assertEqual(net["serverExposureState"]["endpointUrl"], "http://192.168.4.33:5000")
        self.assertEqual([e["id"] for e in net["advertisedEndpoints"]], ["desktop-loopback:5000", "desktop-lan:http://192.168.4.33:5000", "tailscale-ip:http://100.95.103.5:5000", "tailscale-magicdns:https://box.tail.ts.net"])
        self.assertEqual(net["advertisedEndpoints"][3]["status"], "unavailable")

    def test_requests(self):
        base = {"mode": "local-only", "tailscaleServeEnabled": False, "tailscaleServePort": 443}
        nxt, restart, tailscale = se.apply_request({"mode": "network-accessible"}, base)
        self.assertEqual((nxt["mode"], restart, tailscale), ("network-accessible", True, False))
        nxt, restart, tailscale = se.apply_request({"tailscaleServe": {"enabled": True, "port": 8443}}, base)
        self.assertEqual((nxt["tailscaleServePort"], restart, tailscale), (8443, False, True))
        with self.assertRaises(ValueError):
            se.apply_request({"tailscaleServe": {"enabled": True, "port": 0}}, base)

    def test_settings_and_files_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            self.assertEqual(se.load_settings(d)["mode"], "local-only")
            se.save_settings(d, {"mode": "network-accessible", "tailscaleServeEnabled": False, "tailscaleServePort": 443})
            self.assertEqual(se.bind_host(se.load_settings(d)), "0.0.0.0")
            files = se.ExposureFiles(d)
            (d / "exposure-request.json").write_text(json.dumps({"id": "r1", "mode": "local-only"}))
            self.assertEqual(files.take_request(), {"id": "r1", "mode": "local-only"})
            self.assertIsNone(files.take_request())
            files.write_state({"a": 1}, {"id": "r1", "ok": True})
            self.assertEqual(json.loads((d / "exposure-state.json").read_text())["lastResult"]["id"], "r1")
