import json
import threading
import time
import unittest
import urllib.error
import urllib.request
from urllib.parse import unquote

from tools import codex_auth as ca

STATE = "abcdefghijklmnop1234"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class CodexAuthTest(unittest.TestCase):
    def test_callback_validation(self):
        redirect = "http://127.0.0.1:1455/auth/callback"
        self.assertEqual(ca.callback_url(f"127.0.0.1:1455/auth/callback?code=c&state={STATE}", redirect, STATE), f"http://127.0.0.1:1455/auth/callback?code=c&state={STATE}")
        for bad in (f"http://127.0.0.1:1455/auth/callback?code=c&state=other", f"http://127.0.0.1:9/auth/callback?code=c&state={STATE}", f"http://127.0.0.1:1455/auth/callback?state={STATE}"):
            with self.assertRaises(ValueError):
                ca.callback_url(bad, redirect, STATE)

    def test_delivery_fragment(self):
        url = ca.delivery_url("t3code://app/welcome#agents:codex", {"environmentId": "e", "instanceId": "i", "flowId": "f"}, "http://x/cb?code=1")
        base, _, frag = url.partition("#codex-auth=")
        self.assertEqual(base, "t3code://app/welcome")
        self.assertEqual(json.loads(unquote(frag)), {"environmentId": "e", "instanceId": "i", "flowId": "f", "callbackUrl": "http://x/cb?code=1", "returnHash": "#agents:codex"})

    def test_listener_redirects_the_callback_once(self):
        port = 14551
        opened = []
        thread = ca.receive({"redirectUri": f"http://127.0.0.1:{port}/auth/callback", "state": STATE, "destination": "t3code://app/settings/providers",
                             "delivery": {"environmentId": "e", "instanceId": "i", "flowId": "f"}, "authorizationUrl": "https://auth.openai.com/x"},
                            open_browser=lambda url: opened.append(url) or True)
        self.assertIsNotNone(thread)
        opener = urllib.request.build_opener(NoRedirect)
        for _ in range(40):
            try:
                opener.open(f"http://127.0.0.1:{port}/auth/callback?code=c&state=wrong", timeout=2)
            except urllib.error.HTTPError as error:
                self.assertEqual(error.code, 400)
                break
            except urllib.error.URLError:
                time.sleep(0.05)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            opener.open(f"http://127.0.0.1:{port}/auth/callback?code=c&state={STATE}", timeout=2)
        self.assertEqual(caught.exception.code, 303)
        self.assertTrue(caught.exception.headers["location"].startswith("t3code://app/settings/providers#codex-auth="))
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(opened, ["https://auth.openai.com/x"])
