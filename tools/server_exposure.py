"""Network access for the app-owned server (apps/desktop/src/backend/DesktopServerExposure.ts,
DesktopNetworkInterfaces.ts, tailscaleEndpointProvider.ts and packages/tailscale, macOS).

The launcher owns the server, so the app asks for a change by writing `exposure-request.json` next to its bootstrap
file; the launcher applies it (persisting the mode in `<data dir>/server-exposure.json`, restarting the server bound to
0.0.0.0 or 127.0.0.1, running `tailscale serve`), then restarts the window, as the reference relaunches the app, and
answers in `exposure-state.json` (the DesktopServerExposureState the app's Network access row reads, its advertised
endpoints, and the result of the last request).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request

LOOPBACK_HOST = "127.0.0.1"
LAN_BIND_HOST = "0.0.0.0"
DEFAULT_TAILSCALE_SERVE_PORT = 443
TAILSCALE_CANDIDATES = ("/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale")
# Private bridges and VM adapters are fallbacks; host bridges can carry the real LAN address.
HOST_ONLY_INTERFACE = re.compile(r"^(bridge\d|utun|ipsec|ppp|tun|tap|wg|docker|br-|veth|virbr|vmnet|vboxnet|VirtualBox|VMware)")


def is_tailscale_ipv4(address: str) -> bool:
    parts = address.split(".")
    return len(parts) == 4 and parts[0] == "100" and 64 <= int(parts[1]) <= 127


def is_usable_lan_ipv4(address: str) -> bool:
    return not address.startswith("127.") and not address.startswith("169.254.") and not is_tailscale_ipv4(address)


def parse_ifconfig(text: str) -> list[tuple[str, str]]:
    """(interface, IPv4 address) pairs, in order."""
    out, name = [], None
    for line in text.splitlines():
        header = re.match(r"^([A-Za-z0-9_.-]+): flags=", line)
        if header:
            name = header.group(1)
            continue
        inet = re.match(r"^\s+inet (\d+\.\d+\.\d+\.\d+)", line)
        if inet and name:
            out.append((name, inet.group(1)))
    return out


def resolve_lan_host(addresses: list[tuple[str, str]], explicit: str | None = None) -> str | None:
    if explicit and explicit.strip():
        return explicit.strip()
    lan = [(n, a) for n, a in addresses if n != "lo0" and is_usable_lan_ipv4(a)]
    preferred = next(((n, a) for n, a in lan if not HOST_ONLY_INTERFACE.match(n)), lan[0] if lan else None)
    return preferred[1] if preferred else None


def interface_addresses(run=subprocess.run) -> list[tuple[str, str]]:
    try:
        done = run(["/sbin/ifconfig", "-a"], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return []
    return parse_ifconfig(done.stdout or "")


def tailscale_cli() -> str | None:
    return next((p for p in TAILSCALE_CANDIDATES if os.access(p, os.X_OK)), None)


def tailscale_status(run=subprocess.run) -> dict | None:
    """`tailscale status --json`: the MagicDNS name and tailnet addresses, or None when Tailscale is not running."""
    cli = tailscale_cli()
    if not cli:
        return None
    try:
        done = run([cli, "status", "--json"], capture_output=True, text=True, timeout=5)
        data = json.loads(done.stdout or "null") if done.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None
    if not isinstance(data, dict) or data.get("BackendState") != "Running":
        return None
    me = data.get("Self") or {}
    dns = (me.get("DNSName") or "").rstrip(".") or None
    ips = [ip for ip in me.get("TailscaleIPs") or [] if isinstance(ip, str) and "." in ip]
    return {"magicDnsName": dns, "tailnetIpv4Addresses": ips}


def load_settings(data_dir: Path) -> dict:
    try:
        raw = json.loads((data_dir / "server-exposure.json").read_text())
    except (OSError, ValueError):
        raw = {}
    mode = raw.get("mode") if raw.get("mode") in ("local-only", "network-accessible") else "local-only"
    port = raw.get("tailscaleServePort")
    return {
        "mode": mode,
        "tailscaleServeEnabled": raw.get("tailscaleServeEnabled") is True,
        "tailscaleServePort": port if isinstance(port, int) and 1 <= port <= 65535 else DEFAULT_TAILSCALE_SERVE_PORT,
    }


def save_settings(data_dir: Path, settings: dict) -> None:
    path = data_dir / "server-exposure.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(settings))
    os.replace(tmp, path)


def bind_host(settings: dict) -> str:
    return LAN_BIND_HOST if settings["mode"] == "network-accessible" else LOOPBACK_HOST


def endpoint(id_, label, http, reachability, status, description, provider, source, default=False, compat="incompatible"):
    ws = re.sub(r"^http", "ws", http)
    value = {
        "id": id_, "label": label, "provider": provider, "httpBaseUrl": http, "wsBaseUrl": ws,
        "reachability": reachability, "compatibility": {"hostedHttpsApp": compat, "desktopApp": "compatible"},
        "source": source, "status": status, "description": description,
    }
    if default:
        value["isDefault"] = True
    return value


CORE = {"id": "desktop-core", "label": "Desktop", "kind": "core", "isAddon": False}
TAILSCALE = {"id": "tailscale", "label": "Tailscale", "kind": "private-network", "isAddon": True}


def probe_https(url: str) -> bool:
    try:
        with urllib.request.urlopen(f"{url}/api/auth/session", timeout=3) as response:
            return response.status < 500
    except Exception:
        return False


def resolve_state(settings: dict, port: int, addresses, tailscale: dict | None, probe=probe_https) -> dict:
    local = f"http://{LOOPBACK_HOST}:{port}"
    network = settings["mode"] == "network-accessible"
    host = resolve_lan_host(addresses) if network else None
    url = f"http://{host}:{port}" if host else None
    endpoints = [endpoint(f"desktop-loopback:{port}", "This machine", local, "loopback", "available",
                          "Loopback endpoint for this desktop app.", CORE, "desktop-core")]
    if url:
        endpoints.append(endpoint(f"desktop-lan:{url}", "Local network", url, "lan", "available",
                                  "Reachable from devices on the same network.", CORE, "desktop-core", default=True))
    if tailscale:
        if network:
            for ip in tailscale["tailnetIpv4Addresses"]:
                endpoints.append(endpoint(f"tailscale-ip:http://{ip}:{port}", "Tailscale IP", f"http://{ip}:{port}",
                                          "private-network", "available", "Reachable from devices on your tailnet.", TAILSCALE, "desktop-addon"))
        if tailscale["magicDnsName"]:
            serve_port = settings["tailscaleServePort"]
            https = f"https://{tailscale['magicDnsName']}" + ("" if serve_port == 443 else f":{serve_port}")
            reachable = settings["tailscaleServeEnabled"] and probe(https)
            endpoints.append(endpoint(f"tailscale-magicdns:{https}", "Tailscale HTTPS", https, "private-network",
                                      "available" if reachable else "unavailable",
                                      "HTTPS endpoint served by Tailscale Serve." if reachable else "MagicDNS hostname. Configure Tailscale Serve for HTTPS access.",
                                      TAILSCALE, "desktop-addon", compat="compatible" if reachable else "requires-configuration"))
    return {
        "serverExposureState": {
            "mode": settings["mode"], "endpointUrl": url, "advertisedHost": host,
            "tailscaleServeEnabled": settings["tailscaleServeEnabled"], "tailscaleServePort": settings["tailscaleServePort"],
        },
        "advertisedEndpoints": endpoints,
    }


def tailscale_serve(enabled: bool, serve_port: int, local_port: int, run=subprocess.run) -> None:
    """packages/tailscale enable/disable: `serve --bg --https=<port> http://127.0.0.1:<port>`, or that route off."""
    cli = tailscale_cli()
    if not cli:
        raise RuntimeError("Tailscale is not installed.")
    args = ["serve", "--bg", f"--https={serve_port}", f"http://{LOOPBACK_HOST}:{local_port}"] if enabled else ["serve", f"--https={serve_port}", "off"]
    done = run([cli, *args], capture_output=True, text=True, timeout=30)
    if done.returncode != 0:
        raise RuntimeError((done.stderr or done.stdout or "Failed to configure Tailscale HTTPS.").strip())


class ExposureFiles:
    """The request / state files beside the app's bootstrap file."""

    def __init__(self, bootstrap_dir: Path):
        self.request = bootstrap_dir / "exposure-request.json"
        self.state = bootstrap_dir / "exposure-state.json"

    def take_request(self) -> dict | None:
        try:
            data = json.loads(self.request.read_text())
        except (OSError, ValueError):
            return None
        self.request.unlink(missing_ok=True)
        return data if isinstance(data, dict) else None

    def write_state(self, state: dict, result: dict | None = None) -> None:
        value = dict(state)
        if result is not None:
            value["lastResult"] = result
        tmp = self.state.with_suffix(".tmp")
        tmp.write_text(json.dumps(value))
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.state)


def apply_request(request: dict, settings: dict) -> tuple[dict, bool, bool]:
    """(next settings, server restart needed, tailscale change needed). Raises for an invalid request."""
    nxt = dict(settings)
    if "mode" in request:
        if request["mode"] not in ("local-only", "network-accessible"):
            raise ValueError("Unknown network exposure mode.")
        nxt["mode"] = request["mode"]
    tailscale = False
    if "tailscaleServe" in request:
        serve = request["tailscaleServe"] or {}
        nxt["tailscaleServeEnabled"] = serve.get("enabled") is True
        port = serve.get("port", nxt["tailscaleServePort"])
        if not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError("Enter a port from 1 to 65535.")
        nxt["tailscaleServePort"] = port
        tailscale = nxt["tailscaleServeEnabled"] != settings["tailscaleServeEnabled"] or port != settings["tailscaleServePort"]
    return nxt, bind_host(nxt) != bind_host(settings), tailscale
