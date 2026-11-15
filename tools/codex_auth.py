"""The local ChatGPT sign-in callback (packages/shared/src/codexAuthCallback.ts receiveCodexAuthCallback, with
codexAuthHandoff.ts codexCallbackUrl and codexAuthDeliveryUrl), run by the launcher because NSH apps cannot listen.

The app (desktop/codexAuth.ts) writes `codex-auth-request-<state>.json` beside its bootstrap file after a
`t3code://auth/codex` handoff; this listens on the request's 127.0.0.1 port for five minutes, opens the sign-in in the
browser, and answers the callback with a 303 to the return address carrying `#codex-auth=<delivery>`. Credentials and
PKCE stay on the target environment: only the one-time code passes through.
"""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import subprocess
import threading
from urllib.parse import parse_qs, quote, urlsplit, urlunsplit

TIMEOUT_S = 300
PAGE = ('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>T3 Code</title><style>body{font-family:system-ui;display:grid;place-items:center;min-height:90vh;margin:0}main{max-width:360px;padding:32px}h1{font-size:24px}p{line-height:1.6;opacity:.7}</style></head><body><main><h1>Return to T3 Code</h1><p>Your sign-in response has been received. T3 Code is finishing the connection. You can close this tab.</p></main></body></html>')

_listeners: dict[str, threading.Event] = {}


def callback_url(value: str, redirect_uri: str, state: str) -> str:
    """codexCallbackUrl: the callback of this sign-in only, else ValueError."""
    expected = urlsplit(redirect_uri)
    pasted = value.lstrip()
    if not re.match(r"^[a-z][a-z\d+.-]*://", pasted, re.I):
        pasted = f"{expected.scheme}://{pasted}"
    cb = urlsplit(pasted)
    params = parse_qs(cb.query, keep_blank_values=True)
    states, codes, errors, clients = (params.get(k, []) for k in ("state", "code", "error", "client_id"))
    ok = (
        len(value) <= 16_384 and f"{cb.scheme}://{cb.netloc}" == f"{expected.scheme}://{expected.netloc}"
        and cb.path == expected.path and not cb.username and not cb.password and not cb.fragment
        and states == [state] and len(clients) <= 1 and (not clients or re.match(r"^oaiapp_[\w-]+$", clients[0]))
        and ((len(codes) == 1 and codes[0] and not errors) or (len(errors) == 1 and errors[0] and not codes))
    )
    if not ok:
        raise ValueError("This redirect URL does not belong to the current sign-in.")
    return urlunsplit(cb)


def delivery_url(destination: str, delivery: dict, callback: str) -> str:
    """codexAuthDeliveryUrl: the code travels in a fragment, never in a request."""
    parts = urlsplit(destination)
    payload = {**delivery, "callbackUrl": callback, "returnHash": f"#{parts.fragment}" if parts.fragment else ""}
    encoded = quote(json.dumps(payload, separators=(",", ":")), safe="!'()*-._~")
    return urlunsplit((parts.scheme, parts.netloc, parts.path, parts.query, f"codex-auth={encoded}"))


def receive(request: dict, open_browser=lambda url: subprocess.run(["open", url], capture_output=True).returncode == 0) -> threading.Thread | None:
    """Starts the listener for one handoff request; None when it is invalid or already open."""
    try:
        redirect = urlsplit(request["redirectUri"])
        state = request["state"]
        port = int(redirect.port or 0)
        if not re.match(r"^http://127\.0\.0\.1:[1-9]\d{0,4}/auth/callback$", request["redirectUri"]) or port > 65535:
            return None
        destination, delivery, authorization = request["destination"], request["delivery"], request["authorizationUrl"]
    except (KeyError, TypeError, ValueError):
        return None
    if state in _listeners:
        print("This sign-in is already open on this computer.", flush=True)
        return None
    done = threading.Event()
    _listeners[state] = done

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):  # the URL carries the one-time code: never log it
            pass

        def do_GET(self):  # noqa: N802
            try:
                url = callback_url(f"http://{redirect.netloc}{self.path}", request["redirectUri"], state)
            except ValueError:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"This response does not belong to the active sign-in.")
                return
            target = delivery_url(destination, delivery, url)
            self.send_response(303)
            for key, value in (("cache-control", "no-store"), ("referrer-policy", "no-referrer"), ("x-content-type-options", "nosniff"), ("location", target)):
                self.send_header(key, value)
            self.end_headers()
            done.set()

    def run():
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        except OSError:
            print("The ChatGPT callback port is in use on this computer. Close the other sign-in and try again, or paste the redirect URL in T3 Code.", flush=True)
            _listeners.pop(state, None)
            return
        server.timeout = 0.5
        try:
            if not open_browser(authorization):
                print("Could not open your sign-in browser.", flush=True)
                return
            for _ in range(TIMEOUT_S * 2):
                if done.is_set():
                    break
                server.handle_request()
            if not done.is_set():
                print("Sign-in expired. Try again.", flush=True)
        finally:
            server.server_close()
            _listeners.pop(state, None)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread


def take_requests(bootstrap_dir: Path) -> list[dict]:
    out = []
    for path in sorted(bootstrap_dir.glob("codex-auth-request-*.json")):
        try:
            out.append(json.loads(path.read_text()))
        except (OSError, ValueError):
            pass
        path.unlink(missing_ok=True)
    return out


PAGE_UNUSED = PAGE  # the reference's page for a callback without a return address; every handoff here has one
