#!/usr/bin/env python3
"""Run the GPUI app with its own local T3 server and private persistent data."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import queue
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
from urllib.parse import urlparse
import uuid
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_theme import BUILT_ENV, LauncherThemes, LiveThemeWatcher  # noqa: E402
import server_exposure  # noqa: E402
import codex_auth  # noqa: E402
import desktop_browser_bridge  # noqa: E402
import desktop_telemetry_relay  # noqa: E402

APP_HOME = Path.home() / ".t3codegpui"
# The Rust implementation of the server (server-rs/).
RUST_RELEASE_BINARY = ROOT / "server-rs" / "target" / "release" / "t3code"
RUST_DEBUG_BINARY = ROOT / "server-rs" / "target" / "debug" / "t3code"
RUST_SERVER_BINARY = RUST_RELEASE_BINARY if RUST_RELEASE_BINARY.is_file() else RUST_DEBUG_BINARY
SERVER_ENTRY = RUST_SERVER_BINARY


def select_server(environ=None, data_name: str = "server", node: str | None = None, rust_binary: Path | None = None):
    """The command that starts the backend, as an argv prefix (everything before `serve ...`), and its kind.

    Default: the R3 Rust server (`server-rs/target/(release|debug)/t3code`). T3GPUI_SERVER=/abs/path/to/binary
    starts that binary for a test copy (`--data-name <name>`).
    """
    environ = os.environ if environ is None else environ
    choice = (environ.get("T3GPUI_SERVER") or "").strip()
    if not choice or choice == "rust":
        binary = (RUST_RELEASE_BINARY if RUST_RELEASE_BINARY.is_file() else RUST_DEBUG_BINARY) if rust_binary is None else rust_binary
        if not binary.is_file():
            raise RuntimeError(f"R3 Rust server binary is not built: {binary}")
        return [str(binary)], "rust"
    if data_name == "server":
        raise RuntimeError("T3GPUI_SERVER selects another backend for a test copy only: use --data-name <name>, never the main data name")
    binary = Path(choice)
    if not binary.is_file():
        raise RuntimeError(f"T3GPUI_SERVER does not name a built server: {binary}")
    return [str(binary)], "external"


def private_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=False, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError(f"App data directory must be owner-only: {path}")


def open_private_file(path: Path, flags: int):
    fd = os.open(path, flags | getattr(os, "O_NOFOLLOW", 0), 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        os.close(fd)
        raise RuntimeError("An app-owned file is not private")
    return fd


def write_bootstrap_file(path: Path, endpoint: str, token: str, *, overwrite: bool = False) -> None:
    """Write the one-shot bootstrap file the app consumes (and deletes) at startup to learn the
    server's endpoint/token (t3ui/backend/bootstrap.ts consumeLocalBootstrap). `overwrite=True` is
    for re-issuing fresh credentials at the same path after the server was restarted (the app will
    already have consumed and unlinked the previous file by then); the default `False` keeps the
    original guarantee that the very first write never silently clobbers an unexpected existing file.
    """
    fd = open_private_file(path, os.O_WRONLY | os.O_CREAT | (os.O_TRUNC if overwrite else os.O_EXCL))
    with os.fdopen(fd, "w") as handle:
        # Importing settings from the existing T3 installation is not yet
        # verified. Start with this app's own settings until it is.
        json.dump({"endpoint": endpoint, "token": token, "serverEngine": "r3"}, handle)


def available_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def persistent_server_port(data_dir: Path) -> int:
    path = data_dir / "server-port"
    try:
        fd = open_private_file(path, os.O_RDONLY)
    except FileNotFoundError:
        port = available_port()
        fd = open_private_file(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        with os.fdopen(fd, "w") as handle:
            handle.write(str(port))
        return port
    with os.fdopen(fd) as handle:
        value = handle.read(16).strip()
    if not value.isdecimal() or not 0 < int(value) < 65536:
        raise RuntimeError("The saved local server port is invalid")
    return int(value)


def assert_port_free(port: int) -> None:
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
            sock.listen(1)
        except OSError as exc:
            raise RuntimeError(f"Local port {port} is already in use") from exc


# DesktopShellEnvironment.ts (apps/desktop/src/shell): the server gets the user's login shell variables, so agents and
# tools find what a new terminal finds even when the launcher itself was started with a thin environment.
LOGIN_SHELL_ENV_NAMES = (
    "PATH", "LANG", "LC_ALL", "LC_CTYPE", "SSH_AUTH_SOCK", "HOMEBREW_PREFIX", "HOMEBREW_CELLAR", "HOMEBREW_REPOSITORY",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "__MISE_DIFF", "JAVA_HOME",
)
LOCALE_ENV_NAMES = ("LANG", "LC_ALL", "LC_CTYPE")
FALLBACK_LC_CTYPE = "en_US.UTF-8"
LOGIN_SHELL_TIMEOUT = 5
# Read once by main() (macOS), then merged into every server start.
LOGIN_SHELL_ENV: dict | None = None
# The desktop browser bridge's relay (set by main unless T3GPUI_NO_BROWSER_BRIDGE).
BROWSER_BRIDGE = None


def login_shell_candidates(shell: str | None, user_shell: str | None = None) -> list:
    if user_shell is None:
        try:
            import pwd
            user_shell = pwd.getpwuid(os.getuid()).pw_shell
        except (ImportError, KeyError):
            user_shell = None
    out = []
    for candidate in ((shell or "").strip(), (user_shell or "").strip(), "/bin/zsh"):
        if candidate and candidate not in out:
            out.append(candidate)
    return out


def capture_command(names) -> str:
    return "; ".join(f"printf '%s\\n' '__T3CODE_ENV_{n}_START__'; printenv {n} || true; printf '%s\\n' '__T3CODE_ENV_{n}_END__'"
                     for n in names)


def extract_environment(output: str, names) -> dict:
    found = {}
    for name in names:
        start_marker, end_marker = f"__T3CODE_ENV_{name}_START__", f"__T3CODE_ENV_{name}_END__"
        start = output.find(start_marker)
        if start < 0:
            continue
        end = output.find(end_marker, start + len(start_marker))
        if end < 0:
            continue
        value = output[start + len(start_marker):end].removeprefix("\n").removesuffix("\n")
        if value:
            found[name] = value
    return found


def merge_paths(*values) -> str | None:
    seen, entries = set(), []
    for value in values:
        for entry in (value or "").split(":"):
            entry = entry.strip()
            if entry and entry not in seen:
                seen.add(entry)
                entries.append(entry)
    return ":".join(entries) or None


def read_login_shell_environment(env: dict, run=subprocess.run) -> dict:
    for shell in login_shell_candidates(env.get("SHELL")):
        try:
            done = run([shell, "-ilc", capture_command(LOGIN_SHELL_ENV_NAMES)], env=env, stdin=subprocess.DEVNULL,
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, errors="replace",
                       timeout=LOGIN_SHELL_TIMEOUT)
        except (OSError, subprocess.TimeoutExpired):
            continue
        found = extract_environment(done.stdout or "", LOGIN_SHELL_ENV_NAMES) if done.returncode == 0 else {}
        if found.get("PATH"):
            return found
    return {}


def apply_login_shell_environment(env: dict, shell_env: dict) -> dict:
    """installPosixEnvironment's merge (macOS): the login shell's PATH first, then what was inherited."""
    merged = merge_paths(shell_env.get("PATH"), env.get("PATH"))
    if merged:
        env["PATH"] = merged
    if not env.get("SSH_AUTH_SOCK") and shell_env.get("SSH_AUTH_SOCK"):
        env["SSH_AUTH_SOCK"] = shell_env["SSH_AUTH_SOCK"]
    if shell_env.get("__MISE_DIFF"):
        env["__MISE_DIFF"] = shell_env["__MISE_DIFF"]
    for name in ("HOMEBREW_PREFIX", "HOMEBREW_CELLAR", "HOMEBREW_REPOSITORY", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
                 "XDG_RUNTIME_DIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "JAVA_HOME"):
        if not env.get(name) and shell_env.get(name):
            env[name] = shell_env[name]
    if all(not (env.get(n) or "").strip() for n in LOCALE_ENV_NAMES):
        for name in LOCALE_ENV_NAMES:
            if (shell_env.get(name) or "").strip():
                env[name] = shell_env[name].strip()
        if all(not (env.get(n) or "").strip() for n in LOCALE_ENV_NAMES):
            env["LC_CTYPE"] = FALLBACK_LC_CTYPE
    return env


def server_environment(source, data_dir: Path) -> dict:
    """The environment of the app-owned server.

    When the launcher is started from inside a T3 Code development session it inherits that
    session's variables (VITE_DEV_SERVER_URL, VITE_WS_URL, PORT, T3CODE_DESKTOP_DEV, NODE_PATH,
    npm_*). With them the frozen server redirected its web UI to the developer's own frontend
    and resolved modules from the developer's checkout. None of them belong to this app.
    """
    leaked = ("VITE_", "T3CODE_", "npm_", "PNPM_")
    env = {key: value for key, value in source.items()
           if not key.startswith(leaked) and key not in {"PORT", "NODE_PATH", "INIT_CWD", "NODE_PACKAGE_MANAGER"}}
    env["T3CODE_HOME"] = str(data_dir)
    return env


def start_server(node: str | None, data_dir: Path, port: int, server_command: list | None = None, host: str = "127.0.0.1",
                  telemetry_relay: "desktop_telemetry_relay.DesktopTelemetryRelay | None" = None):
    env = server_environment(os.environ, data_dir)
    if LOGIN_SHELL_ENV is not None:
        apply_login_shell_environment(env, LOGIN_SHELL_ENV)
    # The app owns this state directory. Never inherit a development auth token.
    env.pop("T3CODE_DEV_AUTH_TOKEN", None)
    if not env.get("T3_SPEECH_MODULE"):
        speech_entry = ROOT.parent / "T3code/apps/server/node_modules/transcribe-cpp/dist/index.js"
        if speech_entry.is_file():
            env["T3_SPEECH_MODULE"] = speech_entry.resolve().as_uri()
    # Desktop browser bridge (tools/desktop_browser_bridge.py): the server's browser drives the app's native tabs
    # over two extra fds named in a bootstrap envelope, as DesktopBackendManager spawns it. Host telemetry
    # (tools/desktop_telemetry_relay.py) rides the same envelope with its own fd, independently of the browser
    # bridge -- either, both or neither may be active for a given launch.
    extra_args, pass_fds = [], ()
    events_fd = control_fd = None
    if BROWSER_BRIDGE is not None:
        events_fd, control_fd = BROWSER_BRIDGE.server_fds()
        extra_args = ["--mode", "web"]
    telemetry_fd = telemetry_relay.fd_for_child if telemetry_relay is not None else None
    if events_fd is not None or telemetry_fd is not None:
        boot_fd = desktop_browser_bridge.bootstrap_pipe(port, host, events_fd, control_fd, telemetry_fd)
        env["T3CODE_BOOTSTRAP_FD"] = str(boot_fd)
        pass_fds = tuple(fd for fd in (events_fd, control_fd, telemetry_fd, boot_fd) if fd is not None)
    try:
        child = subprocess.Popen(
            [*(server_command or [str(SERVER_ENTRY)]), "serve", "--base-dir", str(data_dir), "--host", host, "--port", str(port), "--no-browser", *extra_args],
            cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, errors="replace", bufsize=1, start_new_session=True, pass_fds=pass_fds,
        )
    finally:
        for fd in pass_fds:
            os.close(fd)
    lines = queue.Queue()

    def read_output():
        assert child.stdout is not None
        for line in child.stdout:
            if line.startswith(("Connection string: ", "Token: ", "Server listening at ")):
                lines.put(line.strip())
            elif line.startswith("Pairing URL: "):
                lines.put(line.strip())
                # The same server serves the original web UI: open this in a
                # browser to compare it with the native window side by side.
                print("Reference web UI: " + line.partition(": ")[2].strip(), flush=True)

    threading.Thread(target=read_output, daemon=True).start()
    try:
        token = None
        address = None
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline and (not token or not address):
            if child.poll() is not None:
                raise RuntimeError("The local server exited during startup")
            try:
                line = lines.get(timeout=0.5)
            except queue.Empty:
                continue
            if line.startswith("Connection string: "):
                address = line.partition(": ")[2]
            elif line.startswith("Server listening at "):
                address = line.removeprefix("Server listening at ").strip()
            elif line.startswith("Token: "):
                token = line.partition(": ")[2]
            elif line.startswith("Pairing URL: ") and not token:
                parsed_pair = urlparse(line.partition(": ")[2])
                for part in parsed_pair.fragment.split("&"):
                    if part.startswith("token="):
                        token = part.partition("=")[2]
                        break
        if not address or not token:
            raise RuntimeError("The local server did not finish starting")
        url = urlparse(address)
        # Network access binds 0.0.0.0; the app itself always talks to the loopback address.
        if url.scheme != "http" or url.port != port or (url.hostname != "127.0.0.1" and host == "127.0.0.1"):
            raise RuntimeError("The local server returned an unexpected address")
        return child, f"ws://127.0.0.1:{port}/ws", token
    except BaseException:
        stop_process(child)
        raise


def mint_reference_pairing_token(node: str | None, data_dir: Path, server_command: list | None = None) -> str:
    """Mint a standalone, independent pairing token for the reference web UI tooling.

    The server's own startup "Pairing URL" token is one-time-use and is the SAME credential the
    native app's bootstrap file consumes: whichever of the native window or the reference browser
    pairs with it first invalidates it for the other, and after any launcher restart the old one
    is gone regardless. `auth pairing create` mints a brand-new, independent token straight from
    the data dir's own local state (no running server session needed, and it never touches the
    native app's bootstrap credential), so the reference browser always gets its own.
    """
    env = server_environment(os.environ, data_dir)
    done = subprocess.run(
        [*(server_command or [str(SERVER_ENTRY)]), "auth", "pairing", "create",
         "--base-dir", str(data_dir), "--ttl", "30d", "--label", "reference-ui", "--json"],
        cwd=ROOT, env=env, capture_output=True, text=True,
    )
    if done.returncode != 0:
        raise RuntimeError(f"Could not mint a reference pairing token: {done.stderr.strip()}")
    try:
        payload = json.loads(done.stdout)
        credential = payload["credential"]
    except (ValueError, KeyError) as exc:
        raise RuntimeError("The minted pairing token response was not in the expected shape") from exc
    if not isinstance(credential, str) or not credential:
        raise RuntimeError("The minted pairing token response had an empty credential")
    return credential


def write_reference_token_file(path: Path, credential: str) -> None:
    """Write the reference UI's own pairing credential to a private file, overwriting any
    previous one (a stale credential from an earlier launcher run is never usable again)."""
    fd = open_private_file(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
    with os.fdopen(fd, "w") as handle:
        handle.write(credential)


def stop_process(child):
    if child is None or child.poll() is not None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
    except ProcessLookupError:
        pass


# DesktopBackendManager.ts calculateRestartDelay: 500ms, doubling, capped at 10s.
INITIAL_RESTART_DELAY = 0.5
MAX_RESTART_DELAY = 10.0
# Not in the TS reference (which resets on bare readiness, DesktopBackendManager.ts:939): a server
# that becomes ready and crashes again almost immediately should keep backing off, not reset to
# 500ms every time. The backoff only resets once a run has stayed up this long.
HEALTHY_RUN_PERIOD = 10.0


def calculate_restart_delay(attempt: int) -> float:
    """Seconds to wait before restart attempt `attempt` (0-based): 0.5, 1, 2, 4, 8, 10, 10, ..."""
    return min(INITIAL_RESTART_DELAY * (2 ** attempt), MAX_RESTART_DELAY)


class ServerSupervisor:
    """Supervises the app-owned server child process (H1 in DESKTOP_PARITY_AUDIT.md).

    Detects an unexpected exit, and a failed/timed-out start, and retries starting the server
    through the same exponential-backoff path (500ms -> 10s, doubling; reset once a run has stayed
    healthy for HEALTHY_RUN_PERIOD). `start()` takes no arguments and must return (child, endpoint,
    token) or raise; `stop(child)` stops a running child. `on_restarted(endpoint, token)` is called
    every time a (re)start succeeds, including the first one, so the caller can re-issue the
    bootstrap file the UI app reads its connection details from.

    Call `poll()` regularly (e.g. once per main-loop tick); it never blocks and never raises. Call
    `stop()` once, on shutdown, so a server that later crashes or a pending retry is not acted on.
    """

    def __init__(self, start, stop, on_restarted=None, clock=time.monotonic, log=None):
        self._start = start
        self._stop = stop
        self._on_restarted = on_restarted or (lambda endpoint, token: None)
        self._clock = clock
        self._log = log or (lambda message: print(message, flush=True))
        self.child: Any = None
        self.endpoint: Any = None
        self.attempt = 0
        self.started_at: float | None = None
        self.retry_at: float | None = None
        self.stopped = False

    @property
    def pending_retry(self) -> bool:
        return self.retry_at is not None

    def _attempt_start(self) -> None:
        try:
            child, endpoint, token = self._start()
        except Exception as exc:
            self._schedule_retry(f"the server could not start ({exc})")
            return
        self.child = child
        self.endpoint = endpoint
        self.started_at = self._clock()
        self.retry_at = None
        self._on_restarted(endpoint, token)
        del token

    def _schedule_retry(self, reason: str) -> None:
        if self.stopped:
            return
        if self.started_at is not None and self._clock() - self.started_at >= HEALTHY_RUN_PERIOD:
            self.attempt = 0
        delay = calculate_restart_delay(self.attempt)
        self.attempt += 1
        self.started_at = None
        self.retry_at = self._clock() + delay
        self._log(f"{reason}; restart scheduled in {delay:.1f}s")

    def poll(self) -> bool:
        """Call once per main-loop tick. Returns True exactly when a (re)start just happened."""
        if self.stopped:
            return False
        if self.child is not None:
            code = self.child.poll()
            if code is None:
                return False
            self.child = None
            self._schedule_retry(f"the server exited unexpectedly (code {code})")
            return False
        if self.retry_at is not None and self._clock() < self.retry_at:
            return False
        self._attempt_start()
        return self.child is not None

    def restart_now(self) -> None:
        """A deliberate restart (e.g. the network-exposure bind host changed), not a failure: stop
        the current child if any and start a fresh one immediately, bypassing any pending backoff.
        A failure here still falls back to the normal backoff/retry path (poll() keeps retrying)."""
        if self.child is not None:
            self._stop(self.child)
            self.child = None
        self.retry_at = None
        self._attempt_start()

    def stop(self) -> None:
        self.stopped = True
        self.retry_at = None
        if self.child is not None:
            self._stop(self.child)
            self.child = None


def cli_environment(data_name: str, server_kind: str, server_command: list, node: str | None, data_dir: Path) -> dict:
    """T3GPUI_CLI_* for the installed `t3` shim (t3ui/desktop/cliCommand.ts). The shim execs the server binary
    directly -- no Node interpreter needed to run it -- so T3GPUI_CLI_ENTRY is the Rust binary's own path, not a
    Node entry script; T3GPUI_CLI_NODE is optional and only used for the shim's best-effort activation hand-off
    twin (a plain-Node script), omitted when there is no system `node`. Offered only for the main app's own real
    Rust binary: never a test/hot-reload data name (it would install a real ~/.local/bin link from a disposable
    copy) and never a T3GPUI_SERVER override (that is a test-harness backend, not a shippable CLI target)."""
    if data_name != "server" or server_kind != "rust" or len(server_command) != 1:
        return {}
    env = {"T3GPUI_CLI_HOME": str(data_dir), "T3GPUI_CLI_ENTRY": str(server_command[0])}
    if node:
        env["T3GPUI_CLI_NODE"] = node
    return env


APP_ENV = (
    "T3GPUI_BOOTSTRAP_FILE",
    # t3ui/desktop/relaunchRequest.ts: tells the app this launcher's main loop actually watches for and consumes
    # relaunch-request.json (see the block below the exposure-request handling), unlike the installed macOS
    # launcher (tools/r3_macos_launcher.c / r3_server_supervisor.swift), which starts the server once and never
    # reads that file. Without this, requestRelaunch() cannot tell the two apart (both have a bootstrap
    # directory) and would report success for a request nobody will ever act on.
    "T3GPUI_LAUNCHER_HANDLES_RELAUNCH",
    "T3GPUI_DESKTOP_BROWSER_SOCKET",
    "T3GPUI_DESKTOP_BROWSER_JS",
    "T3GPUI_MIC_HELPER",
    "T3GPUI_BUILT_THEME",
    # Test override only. The app asks the host (`host.call("webview.underSurface")`, the combined
    # host in third_party/nsh-host answers true) whether WebViews sit below GPUI's own content, and
    # then stops hiding them under overlays (nativeOcclusion.ts). "1" forces that on, "0" forces it
    # off, unset leaves it to the host.
    "T3GPUI_WEBVIEW_UNDER_SURFACE",
    # Test copies only: "x,y" in screen points, where App.tsx places the window (clear of windows covering it).
    "T3GPUI_TEST_WINDOW_ORIGIN",
    # Test copies only (set in main): never bring the window forward (deep links, notification clicks), and open at
    # the launcher's 1280x800 instead of the saved frame. T3GPUI_WINDOW_RESTORE=1 in the launcher's env keeps restore on.
    "T3GPUI_NO_ACTIVATE",
    "T3GPUI_NO_WINDOW_RESTORE",
    # Settings > About's t3 command (desktop/cliCommand.ts): the node, server entry and T3 home its launcher runs, and
    # the login shell's PATH it checks the command against (the window's own PATH is launchd's).
    "T3GPUI_CLI_HOME",
    "T3GPUI_CLI_NODE",
    "T3GPUI_CLI_ENTRY",
    "T3GPUI_LOGIN_PATH",
    "SSH_ASKPASS",
    "SSH_ASKPASS_REQUIRE",
    "T3GPUI_ASKPASS_DIR",
    "SHELL",
    "ZDOTDIR",
    "XDG_CONFIG_HOME",
    "SSH_AUTH_SOCK",
    "LANG",
    "LC_ALL",
)


def launch_app(binary: Path, code_bundle: Path, env: dict, data_dir: Path):
    """Start the window through LaunchServices (`open`), so macOS treats the bundle itself as the app asking for the
    microphone, screen recording, accessibility and automation. Started as a child of this script, the terminal that
    ran the script is the responsible process: no prompt ever names the app and the access is refused silently."""
    log = str(data_dir / "host.log")
    command = ["open", "-n", "-W"]
    if data_dir.name != "server":
        command.append("-g")  # a test copy never takes the keyboard from the main window
    command += ["-a", str(binary.parents[2]), "--stdout", log, "--stderr", log]
    for key in APP_ENV:
        if env.get(key):
            command += ["--env", f"{key}={env[key]}"]
    command += ["--args", "--bundle", str(code_bundle), "--window-size", "1280x800"]
    return subprocess.Popen(command, cwd=ROOT, start_new_session=True)


def host_running(binary) -> bool:
    return subprocess.run(["pgrep", "-f", "^" + re.escape(str(binary)) + " "], capture_output=True).returncode == 0


def host_pid(app: subprocess.Popen, binary) -> int | None:
    """The real host process id telemetry samples should be labeled with (`electronPid` in
    `t3ui/desktop/hostTelemetry.ts`'s wire shape -- this launcher's own stand-in for the reference's Electron
    main-process pid). A direct launch's `app` already IS the host, so `app.pid` is correct. A `launch_app`
    launch (`open -n -W`) is not: `app.pid` is `/usr/bin/open`'s own pid, not the window's, so the host is found
    the same way `host_running`/`stop_app` find it, by its own binary path. `None` when that search finds no
    exactly-one match (not started yet, already exited, or -- extremely unlikely -- more than one match): the
    caller then skips labeling the sample rather than mislabeling it with the wrong pid."""
    if binary is None:
        return app.pid
    result = subprocess.run(["pgrep", "-f", "^" + re.escape(str(binary)) + " "], capture_output=True, text=True)
    if result.returncode != 0:
        return None
    pids = [int(token) for token in result.stdout.split() if token.strip().isdigit()]
    return pids[0] if len(pids) == 1 else None


def stop_app(child, binary) -> None:
    """Stop a window started by launch_app: the host is not our child, so it is found by its own binary path."""
    if binary is not None:
        pattern = "^" + re.escape(str(binary)) + " "
        subprocess.run(["pkill", "-TERM", "-f", pattern], capture_output=True)
        for _ in range(50):
            if subprocess.run(["pgrep", "-f", pattern], capture_output=True).returncode != 0:
                break
            time.sleep(0.1)
        else:
            subprocess.run(["pkill", "-KILL", "-f", pattern], capture_output=True)
    stop_process(child)


class IncompleteBuild(RuntimeError):
    """A themed build that shipped fewer assets than the plain app does (images, icons, fonts missing)."""


def run_nsh_build(nsh: str, entry, out_dir: Path) -> int | None:
    """`nsh build`, its log shown; the asset count it reports (None when it reports none)."""
    shutil.rmtree(out_dir, ignore_errors=True)
    done = subprocess.run([nsh, "build", str(entry), "--release", "--out", str(out_dir)], cwd=ROOT,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
    print(done.stdout, end="", flush=True)
    if done.returncode:
        raise subprocess.CalledProcessError(done.returncode, done.args)
    found = re.search(r"(\d+) assets", done.stdout)
    return int(found.group(1)) if found else None


BUILD_INFO = {"fell_back": False}

PREBUILT_HOST = Path.home() / ".nsh" / "runtime" / "gpui" / "nsh-gpui-host"
# A host built from a patched copy of the NSH runtime (third_party/nsh-host/README.md). Used when present,
# unless T3GPUI_PREBUILT_HOST=1 asks for the prebuilt one.
PATCHED_HOST = ROOT / "third_party" / "nsh-host" / "nsh-gpui-host"


def select_host(environ=None, patched: Path | None = None, prebuilt: Path | None = None) -> tuple[Path, str]:
    """The development host the app bundle copies, and its kind ("custom", "patched" or "prebuilt").

    T3GPUI_HOST=/abs/path/to/host takes precedence over both the patched and the prebuilt host (kind
    "custom"), for running a build of the host from a test copy without touching third_party/nsh-host/
    (which would switch the owner's running app on its next restart).
    """
    environ = os.environ if environ is None else environ
    custom = environ.get("T3GPUI_HOST")
    if custom:
        custom_path = Path(custom)
        if not custom_path.is_file():
            raise RuntimeError(f"T3GPUI_HOST does not name a file: {custom_path}")
        return custom_path, "custom"
    patched = PATCHED_HOST if patched is None else patched
    prebuilt = PREBUILT_HOST if prebuilt is None else prebuilt
    if environ.get("T3GPUI_PREBUILT_HOST") != "1" and patched.is_file():
        return patched, "patched"
    return prebuilt, "prebuilt"


def build_app_bundle(nsh: str, data_dir: Path, entry, plain_entry=None, fallback: bool = False) -> tuple[Path, Path]:
    """Build the UI bundle beside the live one and swap it in on success.

    `entry` is the repo's own entry (a plain build, which records how many assets it shipped) or a themed
    build copy (`plain_entry` names the repo entry it copies). A themed build must ship as many assets as a
    plain one, or images and fonts are missing: the first window (`fallback=True`, nothing to protect) falls
    back to the plain build and says why, a reload refuses the build and leaves the running window alone.
    """
    if sys.platform != "darwin":
        raise RuntimeError("The app bundle option is available on macOS")
    host, host_kind = select_host()
    if not host.is_file():
        raise RuntimeError("The NSH GPUI development host is not installed")
    print(f"Using the {host_kind} NSH GPUI host: {host}", flush=True)
    bundle_dir = data_dir / "ui-bundle"
    next_dir = data_dir / "ui-bundle.next"
    count_file = data_dir / "asset-count"
    BUILD_INFO["fell_back"] = False
    assets = run_nsh_build(nsh, entry, next_dir)
    themed = plain_entry is not None and Path(entry) != Path(plain_entry)
    if not themed:
        if assets is not None:
            count_file.write_text(str(assets))
    else:
        try:
            expected = int(count_file.read_text())
        except (OSError, ValueError):
            expected = None
        if expected and (assets is None or assets < expected * 0.98):
            reason = f"the themed build has {assets} assets, a plain build has {expected}"
            if not fallback:
                shutil.rmtree(next_dir, ignore_errors=True)
                raise IncompleteBuild(reason)
            print(f"Theme not applied: {reason}; building the plain app", flush=True)
            run_nsh_build(nsh, plain_entry, next_dir)
            BUILD_INFO["fell_back"] = True
    shutil.rmtree(bundle_dir, ignore_errors=True)
    os.replace(next_dir, bundle_dir)
    # Client storage (saved session, settings, drafts) is keyed by the bundle's app id. A second instance
    # started with another --data-name gets its own id, so it can never overwrite the main one's storage.
    if data_dir.name != "server":
        manifest = bundle_dir / "app.json"
        details = json.loads(manifest.read_text())
        details["id"] = f"{details['id']}.{re.sub(r'[^A-Za-z0-9]', '', data_dir.name)}"
        manifest.write_text(json.dumps(details))
    app_dir = data_dir / "T3 Code GPUI.app" / "Contents"
    binary_dir = app_dir / "MacOS"
    binary_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    binary = binary_dir / "nsh-gpui-host"
    # The prebuilt host is linked against the macOS 15.5 SDK, so macOS gives its window the old, smaller
    # traffic lights. The copy is re-marked as built against the installed SDK (and re-signed ad hoc) so
    # the window gets the same chrome as the reference app. The stamp records which host the copy came from.
    # Beside the bundle, not in it: a data file in Contents/MacOS stops the bundle from being signed.
    stamp = data_dir / "host.stamp"
    legacy_stamp = binary_dir / "host.stamp"
    if legacy_stamp.exists():
        if not stamp.exists():
            stamp.write_text(legacy_stamp.read_text())
        legacy_stamp.unlink()
    host_id = f"{host_kind}:{host.stat().st_size}:{host.stat().st_mtime_ns}"
    if not binary.exists() or not stamp.exists() or stamp.read_text() != host_id:
        # Copied beside and moved over: a reload may swap the host while the old one still runs from it.
        fresh = binary.with_suffix(".new")
        shutil.copy2(host, fresh)
        os.replace(fresh, binary)
        # The running macOS version, not xcrun's SDK: xcrun follows SDKROOT and can report an older SDK.
        sdk = ".".join((platform.mac_ver()[0].split(".") + ["0"])[:2]) if platform.mac_ver()[0] else ""
        if sdk:
            marked = binary.with_suffix(".marked")
            done = subprocess.run(["vtool", "-set-build-version", "macos", "11.0", sdk, "-replace", "-output", str(marked), str(binary)], capture_output=True)
            if done.returncode == 0 and subprocess.run(["codesign", "-f", "-s", "-", str(marked)], capture_output=True).returncode == 0:
                os.replace(marked, binary)
            else:
                marked.unlink(missing_ok=True)
        stamp.write_text(host_id)
    # A test copy is its own app to macOS (own id and name), so its permissions and input never mix with the main one's.
    suffix = "" if data_dir.name == "server" else re.sub(r"[^A-Za-z0-9]", "", data_dir.name)
    bundle_id = "com.t3codegpui.local" + (f".{suffix}" if suffix else "")
    bundle_name = "R3 Code" + (f" (test {suffix})" if suffix else "")
    resources = app_dir / "Resources"
    resources.mkdir(mode=0o700, parents=True, exist_ok=True)
    icon = ROOT / "assets" / "r3-icon.icns"
    installed_icon = resources / "r3-icon.icns"
    if not installed_icon.exists() or installed_icon.read_bytes() != icon.read_bytes():
        shutil.copy2(icon, installed_icon)
    with (app_dir / "Info.plist").open("wb") as info:
        plistlib.dump({
            "CFBundleDevelopmentRegion": "en", "CFBundleExecutable": "nsh-gpui-host",
            "CFBundleIconFile": "r3-icon.icns",
            "CFBundleIdentifier": bundle_id, "CFBundleInfoDictionaryVersion": "6.0",
            "CFBundleName": bundle_name, "CFBundleDisplayName": bundle_name,
            "CFBundlePackageType": "APPL", "CFBundleShortVersionString": "1.0",
            "CFBundleVersion": "1", "NSHighResolutionCapable": True,
            # macOS only shows a permission prompt for an app that declares why it wants the access;
            # without these keys dictation fails silently ("Voice input failed") and no prompt appears.
            "NSMicrophoneUsageDescription": "R3 Code uses the microphone for voice input and dictation.",
            "NSSpeechRecognitionUsageDescription": "R3 Code transcribes your speech for voice input.",
            "NSAppleEventsUsageDescription": "R3 Code shows folder pickers and notifications through macOS.",
            "NSScreenCaptureUsageDescription": "R3 Code captures a window you choose for SnapShots.",
            "NSLocalNetworkUsageDescription": "R3 Code connects to environments and preview servers on your local network.",
            "NSDesktopFolderUsageDescription": "R3 Code opens projects and files you choose in your Desktop folder.",
            "NSDocumentsFolderUsageDescription": "R3 Code opens projects and files you choose in your Documents folder.",
            "NSDownloadsFolderUsageDescription": "R3 Code opens projects and files you choose in your Downloads folder.",
            "NSRemovableVolumesUsageDescription": "R3 Code opens projects and files you choose on removable volumes.",
            "NSNetworkVolumesUsageDescription": "R3 Code opens projects and files you choose on network volumes.",
            "NSCameraUsageDescription": "R3 Code lets web pages in the browser panel use the camera when you allow it.",
            "NSAudioCaptureUsageDescription": "R3 Code records system audio for screen recordings you start.",
            **link_handlers(suffix),
        }, info)
    # macOS keeps permissions (microphone, screen recording, accessibility, automation) per signed app. Signing the
    # whole bundle binds Info.plist and gives the grants a stable identity: the bundle id, not a bare binary's hash.
    # Only when the seal is missing or stale (new host, changed Info.plist): a reload must not re-sign the binary a
    # running window was started from, and an unchanged signature keeps the permissions already granted.
    bundle = str(app_dir.parent)
    described = subprocess.run(["codesign", "-dv", bundle], capture_output=True, text=True).stderr
    sealed = f"Identifier={bundle_id}\n" in described and subprocess.run(["codesign", "--verify", bundle], capture_output=True).returncode == 0
    signed = subprocess.CompletedProcess([], 0, "", "") if sealed else subprocess.run(["codesign", "-f", "-s", "-", "--identifier", bundle_id, bundle], capture_output=True, text=True)
    if signed.returncode != 0:
        print(f"The app bundle could not be signed ({signed.stderr.strip()}); permission prompts may not appear", flush=True)
    return binary, bundle_dir / "bundle.nshc"


ASKPASS_SCRIPT = """#!/bin/sh
# Written by the R3 Code launcher: ssh's SSH_ASKPASS. It hands ssh's prompt to the app (desktop/sshPasswordPrompts.ts)
# through files in this private folder and prints the answer the user gives in the app's SSH verification dialog.
dir="${T3GPUI_ASKPASS_DIR:?}"
id="p$$-$(date +%s)"
umask 077
printf '%s' "$1" > "$dir/$id.prompt.tmp" && mv "$dir/$id.prompt.tmp" "$dir/$id.prompt" || exit 1
trap 'rm -f "$dir/$id.prompt" "$dir/$id.answer" "$dir/$id.cancel"' EXIT
i=0
while [ $i -lt 950 ]; do
  if [ -f "$dir/$id.cancel" ]; then exit 1; fi
  if [ -f "$dir/$id.answer" ]; then cat "$dir/$id.answer"; printf '\\n'; exit 0; fi
  sleep 0.2
  i=$((i + 1))
done
exit 1
"""


def install_askpass(data_dir: Path) -> dict:
    """The askpass helper and the variables ssh children of the app inherit (SSH_ASKPASS_REQUIRE=force: ssh uses it
    without a display; batch-mode calls still never ask)."""
    folder = data_dir / "askpass"
    private_directory(folder)
    for stale in folder.glob("*"):
        if stale.name != "t3-askpass":
            stale.unlink(missing_ok=True)
    helper = folder / "t3-askpass"
    if not helper.exists() or helper.read_text() != ASKPASS_SCRIPT:
        helper.write_text(ASKPASS_SCRIPT)
    helper.chmod(0o700)
    return {"SSH_ASKPASS": str(helper), "SSH_ASKPASS_REQUIRE": "force", "T3GPUI_ASKPASS_DIR": str(folder)}


MIC_HELPER_SOURCE = ROOT / "tools" / "mic-helper" / "t3-mic.swift"


def install_mic_helper(data_dir: Path) -> dict:
    """The microphone helper (tools/mic-helper/t3-mic.swift: input device list and recording from a chosen device),
    compiled with swiftc when its source changes. desktop/audioCapture.ts starts it as a child of the app, so the
    microphone prompt and grant belong to the app. Without swiftc the app keeps its default-input recorder."""
    if sys.platform != "darwin" or not MIC_HELPER_SOURCE.exists():
        return {}
    folder = data_dir / "mic"
    private_directory(folder)
    helper, stamp = folder / "t3-mic", folder / "t3-mic.stamp"
    digest = hashlib.sha256(MIC_HELPER_SOURCE.read_bytes()).hexdigest()
    if not helper.exists() or not stamp.exists() or stamp.read_text() != digest:
        fresh = folder / "t3-mic.new"
        built = subprocess.run(["swiftc", "-O", str(MIC_HELPER_SOURCE), "-o", str(fresh)], capture_output=True, text=True)
        if built.returncode != 0:
            print(f"The microphone helper could not be built ({built.stderr.strip()[-400:]}); microphone choice is unavailable", flush=True)
            fresh.unlink(missing_ok=True)
            return {"T3GPUI_MIC_HELPER": str(helper)} if helper.exists() else {}
        subprocess.run(["codesign", "-f", "-s", "-", str(fresh)], capture_output=True)
        os.replace(fresh, helper)
        stamp.write_text(digest)
    return {"T3GPUI_MIC_HELPER": str(helper)}


def app_url_scheme(suffix: str) -> str:
    """ElectronProtocol.ts: `t3code` (production) / `t3code-dev`. A test copy gets `t3code-<name>` (letters only, as
    promptLinkAppPath's APP_SCHEME accepts) so it never takes the main app's links."""
    letters = re.sub(r"[^a-z]", "", suffix.lower())
    return "t3code" + (f"-{letters}" if letters else "")


def link_handlers(suffix: str) -> dict:
    """The URL scheme the system hands to the app (open-url) and the web page files it can open (open-file,
    DesktopWebLinks.isWebPageFile: .html .htm .xhtml), never as their default handler."""
    return {
        "CFBundleURLTypes": [{"CFBundleURLName": "T3 Code link", "CFBundleURLSchemes": [app_url_scheme(suffix)]}],
        "CFBundleDocumentTypes": [{
            "CFBundleTypeName": "Web page", "CFBundleTypeRole": "Viewer", "LSHandlerRank": "Alternate",
            "CFBundleTypeExtensions": ["html", "htm", "xhtml"], "LSItemContentTypes": ["public.html"],
        }],
    }


def parse_args(argv: list[str] | None = None, *, platform: str | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--app-bundle", dest="app_bundle", action="store_true", help="Run the static macOS GPUI app bundle")
    mode.add_argument("--hot-reload", dest="app_bundle", action="store_false", help="Run the development host with hot reload")
    parser.set_defaults(app_bundle=(platform if platform is not None else sys.platform) == "darwin")
    parser.add_argument("--ui-port", type=int, help="Hot-reload development port; defaults to an unused local port")
    parser.add_argument("--data-name", default="server", help="App-owned server data directory name")
    parser.add_argument("--entry", default="t3ui/App.tsx", help="NSH entry module")
    args = parser.parse_args(argv)
    if args.ui_port is not None and args.app_bundle:
        parser.error("--ui-port requires --hot-reload")
    return args


def main() -> int:
    args = parse_args()
    if not args.data_name or args.data_name in {".", "..", "bootstrap"} or Path(args.data_name).name != args.data_name:
        raise RuntimeError("Invalid app data directory name")
    node, nsh = shutil.which("node"), shutil.which("nsh")
    if not nsh or not SERVER_ENTRY.is_file():
        raise RuntimeError("This development launch needs NSH and a built R3 Rust server")

    private_directory(APP_HOME)
    bootstrap_dir = APP_HOME / "bootstrap"
    private_directory(bootstrap_dir)
    # A test copy (any data name but the main one) keeps its bootstrap and theme request files in its own
    # folder: two launchers watching one theme-request.json rebuilt each other's windows in turn.
    if args.data_name != "server":
        bootstrap_dir = bootstrap_dir / args.data_name
        private_directory(bootstrap_dir)
    data_dir = APP_HOME / args.data_name
    private_directory(data_dir)
    # Always its own per-data-name folder (unlike bootstrap_dir above, which stays flat for the
    # main app): a dedicated, never-printed home for the reference UI's own pairing credential.
    reference_token_dir = APP_HOME / "bootstrap" / args.data_name
    private_directory(reference_token_dir)
    reference_token_path = reference_token_dir / "reference-token"
    lock_fd = open_private_file(data_dir / "supervisor.lock", os.O_RDWR | os.O_CREAT)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as exc:
        os.close(lock_fd)
        raise RuntimeError("This app-owned local server is already running") from exc

    supervisor = None
    app = None
    app_binary = None
    live_themes = None
    bootstrap_path = bootstrap_dir / f"bootstrap-{uuid.uuid4()}.json"
    previous_handlers = {}
    def terminate(_signum, _frame):
        raise KeyboardInterrupt
    for sig in (signal.SIGTERM, signal.SIGHUP):
        previous_handlers[sig] = signal.signal(sig, terminate)
    try:
        port = persistent_server_port(data_dir)
        ui_port = None if args.app_bundle else args.ui_port if args.ui_port is not None else available_port()
        if ui_port is not None and (not 0 < ui_port < 65536 or ui_port == port):
            raise RuntimeError("Invalid NSH development port")
        assert_port_free(port)
        if ui_port is not None:
            assert_port_free(ui_port)
        # The palette is fixed when the bundle is built, so the app asks for a re-themed rebuild by writing
        # theme-request.json (see build_theme.py). The last request is applied here, so a choice survives restarts.
        themes = LauncherThemes(bootstrap_dir, data_dir / "theme-stage", ROOT / args.entry) if args.app_bundle and not os.environ.get("T3GPUI_NO_THEME_STAGE") else None
        if themes:
            themes.start()
        # The live-apply fast path (third_party/nsh-host/README.md "live theme"): a thread of its
        # own, polled far more often than the rebuild loop below, so a host that can apply theme
        # tokens live is never held to that loop's ~0.5 s cadence. Harmless to start unconditionally
        # (the stock host's app never writes its request file, so it never fires); shares the one
        # cached Sources() load with `themes`.
        live_themes = LiveThemeWatcher(bootstrap_dir, themes._sources) if themes else None
        if live_themes:
            live_themes.start()
        bundled_app = (build_app_bundle(nsh, data_dir, themes.entry if themes else args.entry,
                                        themes.app_entry if themes else None, fallback=True) if args.app_bundle else None)
        if themes and BUILD_INFO["fell_back"]:
            themes.use_default()
        print("Starting the app-owned local environment...", flush=True)
        server_command, server_kind = select_server(os.environ, args.data_name, node)
        print(f"Using the {server_kind} backend: {server_command[0]}", flush=True)
        global LOGIN_SHELL_ENV
        if sys.platform == "darwin" and not os.environ.get("T3GPUI_NO_LOGIN_SHELL_ENV"):
            LOGIN_SHELL_ENV = read_login_shell_environment(server_environment(os.environ, data_dir))
        exposure_files = server_exposure.ExposureFiles(bootstrap_dir)
        exposure = server_exposure.load_settings(data_dir)
        global BROWSER_BRIDGE
        if not os.environ.get("T3GPUI_NO_BROWSER_BRIDGE") and bundled_app and desktop_browser_bridge.host_supports_bridge(bundled_app[0]):
            BROWSER_BRIDGE = desktop_browser_bridge.DesktopBrowserBridge(
                desktop_browser_bridge.socket_path(args.data_name), os.environ.get("T3GPUI_BRIDGE_LOG"))
        # Host telemetry relay (tools/desktop_telemetry_relay.py): a fresh pipe per (re)start, since the read end
        # is handed to a specific child and cannot outlive it. `current_telemetry` is a mutable cell the main
        # loop's sample-forwarding tick (below) reads, the same shape as `current_host`.
        telemetry_enabled = not os.environ.get("T3GPUI_NO_TELEMETRY_RELAY")
        current_telemetry: dict[str, Any] = {"value": None}

        # H1 (DESKTOP_PARITY_AUDIT.md): the server is supervised, not just spawned once. `current_host`
        # is a mutable cell so a later network-exposure change (below) can rebind without recreating
        # the supervisor. `reissue_bootstrap` re-issues the one-shot bootstrap file the app reads its
        # endpoint/token from (t3ui/backend/bootstrap.ts) every time the server (re)starts, so the app
        # can reconnect after an unexpected restart; it is also how the app learns about the very first
        # start, matching the previous single write_bootstrap_file call.
        current_host = {"value": server_exposure.bind_host(exposure)}

        def start_backend():
            relay = desktop_telemetry_relay.DesktopTelemetryRelay() if telemetry_enabled else None
            try:
                result = start_server(node, data_dir, port, server_command, current_host["value"], relay)
            except Exception:
                if relay is not None:
                    relay.close()
                raise
            old = current_telemetry["value"]
            current_telemetry["value"] = relay
            if old is not None:
                old.close()
            return result

        bootstrap_issued = {"done": False, "endpoint": None, "token": None}

        def reissue_bootstrap(backend_endpoint, backend_token):
            write_bootstrap_file(bootstrap_path, backend_endpoint, backend_token, overwrite=bootstrap_issued["done"])
            bootstrap_issued.update(done=True, endpoint=backend_endpoint, token=backend_token)

        supervisor = ServerSupervisor(start_backend, stop_process, on_restarted=reissue_bootstrap)
        # Blocks (but stays interruptible by SIGTERM/SIGINT, since nothing here is an uninterruptible
        # syscall) until the server comes up, retrying a failed start or a readiness timeout with the
        # same backoff an unexpected exit uses later, instead of failing the launch outright (medium:
        # "Server readiness timeout has no retry").
        while supervisor.child is None:
            supervisor.poll()
            if supervisor.child is None:
                time.sleep(0.1)

        def publish_exposure(result=None):
            exposure_files.write_state(server_exposure.resolve_state(exposure, port, server_exposure.interface_addresses(), server_exposure.tailscale_status()), result)
        publish_exposure()
        (bootstrap_dir / "relaunch-request.json").unlink(missing_ok=True)  # a stale request must not loop a fresh launch
        # A fresh, independent credential every launcher start: never the native app's own
        # bootstrap token, and never reused past this process (a restart mints another one).
        write_reference_token_file(reference_token_path, mint_reference_pairing_token(node, data_dir, server_command))
        env = os.environ.copy()
        env["T3GPUI_BOOTSTRAP_FILE"] = str(bootstrap_path)
        env["T3GPUI_LAUNCHER_HANDLES_RELAUNCH"] = "1"
        if BROWSER_BRIDGE is not None:
            env["T3GPUI_DESKTOP_BROWSER_SOCKET"] = str(BROWSER_BRIDGE.path)
        env.update(install_askpass(data_dir))
        env.update(install_mic_helper(data_dir))
        login_path = merge_paths((LOGIN_SHELL_ENV or {}).get("PATH"), os.environ.get("PATH"))
        if login_path:
            env["T3GPUI_LOGIN_PATH"] = login_path
        env.update(cli_environment(args.data_name, server_kind, server_command, node, data_dir))
        if args.data_name != "server":
            env["T3GPUI_NO_ACTIVATE"] = "1"
            if not os.environ.get("T3GPUI_WINDOW_RESTORE"):
                env["T3GPUI_NO_WINDOW_RESTORE"] = "1"
        if themes and themes.meta:
            env[BUILT_ENV] = json.dumps(themes.meta)
        if bundled_app:
            binary, code_bundle = bundled_app
            command = [str(binary), "--bundle", str(code_bundle), "--window-size", "1280x800"]
        else:
            command = [nsh, "run", args.entry, "--target", "gpui", "--port", str(ui_port), "--window-size", "1280x800"]
        direct = not bundled_app or bool(os.environ.get("T3GPUI_DIRECT_LAUNCH"))
        start_app = (lambda: subprocess.Popen(command, cwd=ROOT, env=env, start_new_session=True)) if direct else (lambda: launch_app(bundled_app[0], bundled_app[1], env, data_dir))
        app_binary = None if direct else bundled_app[0]
        app = start_app()
        # SIGUSR1 rebuilds the UI and restarts only the window. The server keeps running, so a
        # thread that is mid-turn is not interrupted; the app signs back in with its saved session.
        reload_requested = threading.Event()
        previous_handlers[signal.SIGUSR1] = signal.signal(signal.SIGUSR1, lambda _signum, _frame: reload_requested.set())
        while True:
            try:
                code = app.wait(timeout=0.5)
                # `open -W` can return while the window it started is still running (seen under heavy load): the
                # window itself decides. Only a host that is really gone ends the session.
                if app_binary is not None and host_running(app_binary):
                    if not getattr(app, "_reported_detached", False):
                        print(f"`open` returned (exit {code}) at {time.strftime('%H:%M:%S')} but the window is still running; keeping the local environment up", flush=True)
                        app._reported_detached = True
                    time.sleep(0.5)
                else:
                    print(f"The window closed (exit {code}) at {time.strftime('%H:%M:%S')}; stopping the local environment", flush=True)
                    return code
            except subprocess.TimeoutExpired:
                pass
            # H1: detect an unexpectedly-exited server and restart it (backoff in ServerSupervisor).
            # A restart here is never one this loop asked for (the exposure branch below calls
            # restart_now() directly), so it always means the app's connection just died; restart the
            # app too so it re-reads the freshly re-issued bootstrap file instead of sitting on a dead
            # socket (the bootstrap file is consumed once, at the app's own startup).
            if supervisor.poll():
                print(f"The local server restarted after an unexpected exit at {time.strftime('%H:%M:%S')}; restarting the app so it can reconnect", flush=True)
                stop_app(app, app_binary)
                app = start_app()
            for handoff in codex_auth.take_requests(bootstrap_dir):
                codex_auth.receive(handoff)
            # t3ui/desktop/hostTelemetry.ts's publisher drops a sample file beside the bootstrap file; forward it
            # into whichever relay the current server was started with (None before the first start, or briefly
            # during a restart -- the sample is simply dropped, same as a missed tick elsewhere in this loop).
            telemetry_sample = desktop_telemetry_relay.take_sample(bootstrap_dir)
            if telemetry_sample is not None and current_telemetry["value"] is not None:
                # H: `electronPid` must label the window host, not this launcher script (os.getpid() was
                # always wrong here -- it named the launcher, which Diagnostics then showed as the "Electron"
                # process). `app_binary` is None for a direct launch, where `app.pid` already is the host.
                pid = host_pid(app, app_binary)
                if pid is not None:
                    current_telemetry["value"].forward(telemetry_sample, pid)
            # t3ui/desktop/relaunchRequest.ts: a window-only restart (local-environment toggle, startup-recovery
            # retry); the server is untouched, so the one-shot bootstrap file is re-issued for the new window.
            relaunch_file = bootstrap_dir / "relaunch-request.json"
            if relaunch_file.exists():
                try:
                    reason = json.loads(relaunch_file.read_text()).get("reason", "")
                except (OSError, ValueError):
                    reason = ""
                relaunch_file.unlink(missing_ok=True)
                print(f"Relaunching the window ({reason or 'requested'})", flush=True)
                stop_app(app, app_binary)
                if bootstrap_issued["endpoint"] is not None:
                    write_bootstrap_file(bootstrap_path, bootstrap_issued["endpoint"], bootstrap_issued["token"], overwrite=True)
                app = start_app()
                continue
            request = exposure_files.take_request()
            if request is not None:
                result = {"id": request.get("id"), "ok": True}
                try:
                    nxt, restart_server, change_tailscale = server_exposure.apply_request(request, exposure)
                    if change_tailscale:
                        server_exposure.tailscale_serve(nxt["tailscaleServeEnabled"], nxt["tailscaleServePort"], port)
                    server_exposure.save_settings(data_dir, nxt)
                    exposure = nxt
                    if restart_server:
                        # DesktopLifecycle.relaunch: the server comes back bound to the new host, then the window.
                        print(f"Restarting the local server for network access ({exposure['mode']})", flush=True)
                        stop_app(app, app_binary)
                        current_host["value"] = server_exposure.bind_host(exposure)
                        supervisor.restart_now()
                    publish_exposure(result)
                    # restart_now() never raises: a start failure just schedules a backoff retry (same
                    # as an unexpected exit). Only bring the app back once the server is actually up;
                    # if it is not yet, the crash-recovery branch above starts the app once poll() sees
                    # the retried start succeed.
                    if change_tailscale and not restart_server:
                        stop_app(app, app_binary)
                        app = start_app()
                    elif restart_server and supervisor.child is not None:
                        app = start_app()
                except Exception as exc:  # the app shows the reference's failure toast with this message
                    publish_exposure({"id": request.get("id"), "ok": False, "error": str(exc)})
                continue
            theme_requested = bool(themes) and themes.changed()
            reload_wanted = reload_requested.is_set()
            if not reload_wanted and not theme_requested:
                continue
            reload_requested.clear()
            if not bundled_app:
                continue
            build_entry, pending = themes.entry if themes else args.entry, None
            if theme_requested:
                try:
                    pending = themes.prepare()
                except Exception as exc:
                    print(f"Theme not applied: {exc}", flush=True)
                if pending:
                    build_entry = pending[0]
                elif not reload_wanted:
                    continue
            if themes and not pending:
                themes.refresh()
            try:
                # Build first: a failed build must leave the running window alone.
                build_app_bundle(nsh, data_dir, build_entry, themes.app_entry if themes else None)
            except (subprocess.CalledProcessError, IncompleteBuild) as exc:
                print(f"Reload skipped: the UI did not build ({exc})", flush=True)
                if pending:
                    themes.report(pending[2], False, "The UI did not build with that theme.")
                continue
            if pending:
                themes.commit(pending[1], pending[2])
                env[BUILT_ENV] = json.dumps(themes.meta)
            stop_app(app, app_binary)
            app = start_app()
            print("Reloaded the UI", flush=True)
    finally:
        if live_themes:
            live_themes.stop()
        # Stop the app first (SIGINT/SIGTERM sequencing, medium: "No lifecycle sequencing"), then the
        # server, so neither is orphaned: supervisor.stop() marks it as deliberate (suppresses any
        # pending/future auto-restart) before terminate/wait/kill-ing the child, mirroring stop_app.
        stop_app(app, app_binary)
        if supervisor is not None:
            supervisor.stop()
        try:
            bootstrap_path.unlink(missing_ok=True)
        finally:
            os.close(lock_fd)
            for sig, handler in previous_handlers.items():
                signal.signal(sig, handler)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as exc:
        print(f"Could not start the local app: {exc}", file=sys.stderr)
        sys.exit(1)
