import contextlib
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest

from tools import build_theme
from tools.run_local import (
    HEALTHY_RUN_PERIOD,
    ROOT,
    SERVER_ENTRY,
    ServerSupervisor,
    calculate_restart_delay,
    mint_reference_pairing_token,
    parse_args,
    server_environment,
    write_bootstrap_file,
    write_reference_token_file,
)


class LocalLaunchOptionsTest(unittest.TestCase):
    def test_macos_defaults_to_static_bundle(self):
        self.assertTrue(parse_args([], platform="darwin").app_bundle)
        self.assertTrue(parse_args(["--app-bundle"], platform="darwin").app_bundle)

    def test_hot_reload_is_explicit_on_macos_and_accepts_a_port(self):
        options = parse_args(["--hot-reload", "--ui-port", "8792"], platform="darwin")
        self.assertFalse(options.app_bundle)
        self.assertEqual(options.ui_port, 8792)

    def test_non_macos_keeps_development_host_default(self):
        self.assertFalse(parse_args([], platform="linux").app_bundle)

    def test_ui_port_requires_hot_reload_and_modes_are_exclusive(self):
        for args in (["--ui-port", "8792"], ["--hot-reload", "--app-bundle"]):
            with self.subTest(args=args), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                parse_args(args, platform="darwin")

    def test_bootstrap_is_private_and_does_not_enable_provider_import(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bootstrap.json"
            write_bootstrap_file(path, "ws://127.0.0.1:1234/ws", "temporary-credential")
            self.assertEqual(json.loads(path.read_text()), {
                "endpoint": "ws://127.0.0.1:1234/ws", "token": "temporary-credential", "serverEngine": "r3",
            })
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_a_second_write_without_overwrite_refuses_an_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bootstrap.json"
            write_bootstrap_file(path, "ws://127.0.0.1:1234/ws", "first-credential")
            with self.assertRaises(FileExistsError):
                write_bootstrap_file(path, "ws://127.0.0.1:1234/ws", "second-credential")

    def test_overwrite_reissues_fresh_credentials_at_the_same_path(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bootstrap.json"
            write_bootstrap_file(path, "ws://127.0.0.1:1234/ws", "first-credential")
            write_bootstrap_file(path, "ws://127.0.0.1:5678/ws", "second-credential", overwrite=True)
            self.assertEqual(json.loads(path.read_text()), {
                "endpoint": "ws://127.0.0.1:5678/ws", "token": "second-credential", "serverEngine": "r3",
            })
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)


class FakeClock:
    """A controllable monotonic clock for ServerSupervisor tests."""

    def __init__(self, start: float = 0.0):
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FakeChild:
    def __init__(self):
        self.returncode = None
        self.stopped = False

    def poll(self):
        return self.returncode

    def crash(self, code: int = 1) -> None:
        self.returncode = code


class FakeServerFactory:
    """Hands out FakeChild processes; `fail_next(n)` makes the next n start() calls raise instead."""

    def __init__(self):
        self.children = []
        self._fail_remaining = 0
        self.start_calls = 0

    def fail_next(self, n: int) -> None:
        self._fail_remaining += n

    def start(self):
        self.start_calls += 1
        if self._fail_remaining > 0:
            self._fail_remaining -= 1
            raise RuntimeError("the local server did not finish starting")
        child = FakeChild()
        self.children.append(child)
        return child, f"ws://127.0.0.1:{9000 + len(self.children)}/ws", f"token-{len(self.children)}"

    def stop(self, child) -> None:
        child.stopped = True


class ServerSupervisorTest(unittest.TestCase):
    def make_supervisor(self):
        clock = FakeClock()
        factory = FakeServerFactory()
        restarts = []
        logs = []
        supervisor = ServerSupervisor(
            factory.start, factory.stop, on_restarted=lambda endpoint, token: restarts.append((endpoint, token)),
            clock=clock, log=logs.append,
        )
        return supervisor, factory, clock, restarts, logs

    def test_first_poll_starts_the_server_and_issues_credentials(self):
        supervisor, factory, _clock, restarts, _logs = self.make_supervisor()
        self.assertTrue(supervisor.poll())
        self.assertIsNotNone(supervisor.child)
        self.assertEqual(factory.start_calls, 1)
        self.assertEqual(restarts, [("ws://127.0.0.1:9001/ws", "token-1")])

    def test_a_healthy_server_is_left_alone(self):
        supervisor, _factory, clock, restarts, _logs = self.make_supervisor()
        supervisor.poll()
        clock.advance(1.0)
        self.assertFalse(supervisor.poll())
        self.assertEqual(len(restarts), 1)

    def test_unexpected_exit_is_restarted_with_doubling_backoff(self):
        supervisor, factory, clock, restarts, _logs = self.make_supervisor()
        supervisor.poll()  # attempt 1, runs
        first_child = supervisor.child

        # Crash immediately (well inside HEALTHY_RUN_PERIOD): backoff must not reset.
        first_child.crash()
        self.assertFalse(supervisor.poll())  # detects exit, schedules retry, does not restart yet
        self.assertIsNone(supervisor.child)
        self.assertTrue(supervisor.pending_retry)

        for expected_delay in (0.5, 1.0, 2.0, 4.0, 8.0):
            clock.advance(expected_delay - 0.01)
            self.assertFalse(supervisor.poll())  # too early
            clock.advance(0.01)
            self.assertTrue(supervisor.poll())  # restarts right on schedule
            supervisor.child.crash()
            self.assertFalse(supervisor.poll())

        # 6 restarts so far (1 initial + 5 recoveries); the next delay would double past 10s
        # (0.5 * 2**5 = 16) and must be capped instead.
        self.assertEqual(factory.start_calls, 6)
        self.assertAlmostEqual(supervisor.retry_at - clock.now, 10.0)
        clock.advance(10.0)
        self.assertTrue(supervisor.poll())
        self.assertEqual(factory.start_calls, 7)

    def test_backoff_resets_after_a_healthy_run(self):
        supervisor, _factory, clock, _restarts, _logs = self.make_supervisor()
        supervisor.poll()
        supervisor.child.crash()
        supervisor.poll()
        clock.advance(calculate_restart_delay(0))
        supervisor.poll()  # second start, attempt counter now 1

        # Stays up past the healthy threshold this time.
        clock.advance(HEALTHY_RUN_PERIOD + 0.1)
        supervisor.child.crash()
        supervisor.poll()  # schedules retry; must see the just-finished run as healthy
        self.assertAlmostEqual(supervisor.retry_at, clock.now + calculate_restart_delay(0))

    def test_readiness_timeout_retries_through_the_same_loop_instead_of_raising(self):
        supervisor, factory, clock, restarts, _logs = self.make_supervisor()
        factory.fail_next(2)
        self.assertFalse(supervisor.poll())  # fails, schedules retry (0.5s)
        self.assertIsNone(supervisor.child)
        clock.advance(0.5)
        self.assertFalse(supervisor.poll())  # fails again, schedules retry (1s)
        clock.advance(1.0)
        self.assertTrue(supervisor.poll())  # succeeds on the third attempt
        self.assertEqual(factory.start_calls, 3)
        self.assertEqual(len(restarts), 1)

    def test_stop_suppresses_further_restarts(self):
        supervisor, factory, clock, _restarts, _logs = self.make_supervisor()
        supervisor.poll()
        supervisor.child.crash()
        supervisor.stop()
        self.assertFalse(supervisor.poll())
        clock.advance(100)
        self.assertFalse(supervisor.poll())
        self.assertEqual(factory.start_calls, 1)

    def test_restart_now_bypasses_backoff_for_a_deliberate_restart(self):
        supervisor, factory, _clock, restarts, _logs = self.make_supervisor()
        supervisor.poll()
        first = supervisor.child
        supervisor.restart_now()
        self.assertTrue(first.stopped)
        self.assertIsNotNone(supervisor.child)
        self.assertIsNot(supervisor.child, first)
        self.assertEqual(factory.start_calls, 2)
        self.assertEqual(len(restarts), 2)

    def test_restart_now_falls_back_to_backoff_on_failure(self):
        supervisor, factory, clock, _restarts, _logs = self.make_supervisor()
        supervisor.poll()
        factory.fail_next(1)
        supervisor.restart_now()
        self.assertIsNone(supervisor.child)
        self.assertTrue(supervisor.pending_retry)
        clock.advance(calculate_restart_delay(0))
        self.assertTrue(supervisor.poll())


class RestartDelayTest(unittest.TestCase):
    def test_doubles_with_a_10s_cap(self):
        self.assertEqual([calculate_restart_delay(a) for a in range(7)], [0.5, 1.0, 2.0, 4.0, 8.0, 10.0, 10.0])


class ReferenceTokenFileTest(unittest.TestCase):
    def test_is_private_and_holds_only_the_credential(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reference-token"
            write_reference_token_file(path, "ABCDEFG12345")
            self.assertEqual(path.read_text(), "ABCDEFG12345")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_a_later_launcher_run_overwrites_a_stale_credential(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reference-token"
            write_reference_token_file(path, "FIRST-STALE-ONE")
            write_reference_token_file(path, "SECOND-FRESH-ONE")
            self.assertEqual(path.read_text(), "SECOND-FRESH-ONE")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)


@unittest.skipUnless(SERVER_ENTRY.is_file(), "the R3 Rust server build is not available")
class MintReferencePairingTokenTest(unittest.TestCase):
    """Exercises the real `t3code auth pairing create` CLI (read-only against a scratch data dir:
    it only ever creates files under a throwaway temporary directory, never under ~/.t3codegpui).
    """

    def test_mints_a_credential_independent_of_the_native_bootstrap_token(self):
        from tools.run_local import available_port, start_server, stop_process
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory) / "data"
            data_dir.mkdir(mode=0o700)
            server, _endpoint, _token = start_server(None, data_dir, available_port(), [str(SERVER_ENTRY)])
            try:
                first = mint_reference_pairing_token(None, data_dir)
                second = mint_reference_pairing_token(None, data_dir)
            finally:
                stop_process(server)
            self.assertTrue(first)
            self.assertTrue(second)
            # Each mint is a fresh, independent credential, not a shared/repeated one.
            self.assertNotEqual(first, second)


class ServerEnvironmentTest(unittest.TestCase):
    def test_a_development_session_environment_does_not_reach_the_server(self):
        env = server_environment({
            "PATH": "/usr/bin", "HOME": "/Users/x", "VITE_DEV_SERVER_URL": "http://127.0.0.1:5733",
            "VITE_WS_URL": "ws://127.0.0.1:13773", "PORT": "5733", "T3CODE_DESKTOP_DEV": "1",
            "T3CODE_HOME": "/somewhere/else", "NODE_PATH": "/dev/checkout/node_modules", "npm_package_name": "x",
        }, Path("/data"))
        self.assertEqual(env, {"PATH": "/usr/bin", "HOME": "/Users/x", "T3CODE_HOME": "/data"})


@unittest.skipUnless(build_theme.INDEX_CSS.is_file() and build_theme.PALETTES_TS.is_file(), "the reference checkout is not available")
class ThemeRequestTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        base = Path(self._tmp.name)
        self.bootstrap = base / "bootstrap"
        self.bootstrap.mkdir()
        self.themes = build_theme.LauncherThemes(self.bootstrap, base / "theme-stage", ROOT / "t3ui" / "App.tsx")

    def request(self, **fields):
        body = {"themeLight": "ocean", "themeDark": "ocean", "contrast": 100, "requestId": "r1", **fields}
        path = self.bootstrap / build_theme.REQUEST_FILE
        path.write_text(json.dumps(body))
        return path

    def status(self):
        return json.loads((self.bootstrap / build_theme.STATUS_FILE).read_text())

    def staged_theme(self, directory=None):
        return json.loads(((directory or self.themes.stage_dir) / "theme.json").read_text())

    def test_no_request_builds_the_plain_app_as_ocean(self):
        self.themes.start()
        self.assertEqual(self.themes.meta, {"light": "ocean", "dark": "ocean", "contrast": 100})
        self.assertEqual(self.themes.entry, ROOT / "t3ui" / "App.tsx")
        self.assertFalse(self.themes.stage_dir.exists())

    def test_a_themed_build_copy_has_the_assets_and_leaves_the_repo_theme_alone(self):
        repo_theme = (ROOT / "t3ui" / "theme.json").read_bytes()
        self.request(themeDark="grove")
        self.themes.start()
        stage = self.themes.stage_dir
        self.assertEqual(self.themes.entry, stage / "App.tsx")
        self.assertEqual(self.staged_theme()["cssVars"]["dark"]["background"], "rgb(27,40,33)")
        manifest = json.loads((stage / "nsh.json").read_text())
        self.assertEqual(manifest["theme"], "theme.json")
        self.assertIn(build_theme.BUILT_ENV, manifest["capabilities"]["process"]["env"])
        for asset in ("fonts", "icons", "components", "pages", "App.tsx"):
            self.assertTrue((stage / asset).exists(), asset)
        self.assertEqual(sorted(p.name for p in stage.glob("*.png")), [])
        self.assertEqual((ROOT / "t3ui" / "theme.json").read_bytes(), repo_theme)

    def test_the_saved_request_is_applied_on_start(self):
        self.request(themeDark="grove", contrast=130)
        self.themes.start()
        self.assertEqual(self.themes.meta, {"light": "ocean", "dark": "grove", "contrast": 130})
        self.assertFalse(self.themes.changed())

    def test_a_damaged_saved_request_falls_back_to_ocean(self):
        (self.bootstrap / build_theme.REQUEST_FILE).write_text("{not json")
        self.themes.start()
        self.assertEqual(self.themes.meta["dark"], "ocean")

    def test_a_changed_request_is_staged_beside_the_current_copy_then_committed(self):
        self.request(themeDark="grove")
        self.themes.start()
        before = self.staged_theme()
        self.assertFalse(self.themes.changed())
        self.request(themeLight="iris", themeDark="ember", requestId="r2")
        self.assertTrue(self.themes.changed())
        entry, meta, request_id = self.themes.prepare()
        self.assertEqual((meta, request_id), ({"light": "iris", "dark": "ember", "contrast": 100}, "r2"))
        self.assertEqual(entry, self.themes.pending_dir / "App.tsx")
        self.assertTrue((self.themes.pending_dir / "icons").exists())
        self.assertEqual(self.staged_theme(), before)  # the running window's copy is untouched until it is up
        self.assertNotEqual(self.staged_theme(self.themes.pending_dir), before)
        self.themes.commit(meta, request_id)
        self.assertEqual(self.themes.meta, meta)
        self.assertEqual(self.staged_theme(), build_theme.build_theme(build_theme.normalize_request(
            {"themeLight": "iris", "themeDark": "ember"}), self.themes.sources)[0])
        self.assertEqual(self.status()["requestId"], "r2")
        self.assertTrue(self.status()["ok"])

    def test_a_request_for_what_is_showing_needs_no_rebuild(self):
        self.themes.start()
        self.request(requestId="r9")
        self.assertTrue(self.themes.changed())
        self.assertIsNone(self.themes.prepare())
        self.assertEqual(self.status(), {**self.status(), "requestId": "r9", "ok": True})

    def test_an_unusable_request_is_reported_and_keeps_the_current_theme(self):
        self.request(themeDark="grove")
        self.themes.start()
        before = self.staged_theme()
        self.request(themeDark="no-such-theme", requestId="r3")
        self.assertTrue(self.themes.changed())
        with self.assertRaises(build_theme.ThemeError):
            self.themes.prepare()
        self.assertEqual(self.status()["requestId"], "r3")
        self.assertFalse(self.status()["ok"])
        self.assertIn("no-such-theme", self.status()["message"])
        self.assertEqual(self.staged_theme(), before)
        self.assertEqual(self.themes.meta["dark"], "grove")
        # A failed build is reported by the launcher; the copy it tried is not the current one.
        self.request(themeDark="iris", requestId="r4")
        self.assertTrue(self.themes.changed())
        self.assertIsNotNone(self.themes.prepare())
        self.themes.report("r4", False, "The UI did not build with that theme.")
        self.assertFalse(self.status()["ok"])
        self.assertEqual(self.staged_theme(), before)


class HostSelectionTest(unittest.TestCase):
    def test_prefers_the_patched_host_and_can_be_forced_back(self):
        from tools.run_local import select_host
        with tempfile.TemporaryDirectory() as tmp:
            patched, prebuilt = Path(tmp) / "patched", Path(tmp) / "prebuilt"
            prebuilt.write_text("prebuilt")
            self.assertEqual(select_host({}, patched, prebuilt), (prebuilt, "prebuilt"))
            patched.write_text("patched")
            self.assertEqual(select_host({}, patched, prebuilt), (patched, "patched"))
            self.assertEqual(select_host({"T3GPUI_PREBUILT_HOST": "1"}, patched, prebuilt), (prebuilt, "prebuilt"))
            self.assertEqual(select_host({"T3GPUI_PREBUILT_HOST": "0"}, patched, prebuilt), (patched, "patched"))

    def test_t3gpui_host_overrides_both_the_patched_and_prebuilt_host(self):
        from tools.run_local import select_host
        with tempfile.TemporaryDirectory() as tmp:
            patched, prebuilt, custom = Path(tmp) / "patched", Path(tmp) / "prebuilt", Path(tmp) / "custom-host"
            patched.write_text("patched")
            prebuilt.write_text("prebuilt")
            custom.write_text("custom")
            # Beats the patched host, present or not, and beats T3GPUI_PREBUILT_HOST=1 too.
            self.assertEqual(
                select_host({"T3GPUI_HOST": str(custom)}, patched, prebuilt), (custom, "custom")
            )
            self.assertEqual(
                select_host({"T3GPUI_HOST": str(custom), "T3GPUI_PREBUILT_HOST": "1"}, patched, prebuilt),
                (custom, "custom"),
            )

    def test_t3gpui_host_naming_a_missing_file_is_an_error(self):
        from tools.run_local import select_host
        with tempfile.TemporaryDirectory() as tmp:
            patched, prebuilt = Path(tmp) / "patched", Path(tmp) / "prebuilt"
            prebuilt.write_text("prebuilt")
            missing = Path(tmp) / "no-such-host"
            with self.assertRaises(RuntimeError):
                select_host({"T3GPUI_HOST": str(missing)}, patched, prebuilt)


class SelectServerTest(unittest.TestCase):
    """Default is the R3 Rust server; T3GPUI_SERVER=<path> overrides it for a test copy only."""

    def test_the_default_is_the_rust_server_for_every_data_name(self):
        from tools.run_local import select_server
        with tempfile.TemporaryDirectory() as tmp:
            binary = Path(tmp) / "t3code"
            binary.write_text("x")
            for name in ("server", "rustsrv"):
                self.assertEqual(select_server({}, name, None, binary), ([str(binary)], "rust"))
                self.assertEqual(select_server({"T3GPUI_SERVER": "rust"}, name, None, binary), ([str(binary)], "rust"))

    def test_a_path_names_the_binary_for_a_test_copy(self):
        from tools.run_local import select_server
        with tempfile.TemporaryDirectory() as tmp:
            binary = Path(tmp) / "custom-server"
            binary.write_text("x")
            self.assertEqual(select_server({"T3GPUI_SERVER": str(binary)}, "rustsrv", None), ([str(binary)], "external"))

    def test_the_main_data_name_never_switches_backend(self):
        from tools.run_local import select_server
        with tempfile.TemporaryDirectory() as tmp:
            binary = Path(tmp) / "custom-server"
            binary.write_text("x")
            with self.assertRaises(RuntimeError):
                select_server({"T3GPUI_SERVER": str(binary)}, "server", None)

    def test_a_missing_binary_is_an_error_not_a_fallback(self):
        from tools.run_local import select_server
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(RuntimeError):
                select_server({"T3GPUI_SERVER": "rust"}, "rustsrv", None, Path(tmp) / "missing")

    def test_the_server_command_prefix_is_used_to_start_and_to_mint(self):
        import tools.run_local as rl
        calls = []
        class Boom(Exception):
            pass
        def fake_popen(argv, **kwargs):
            calls.append(argv)
            raise Boom()
        original = rl.subprocess.Popen
        rl.subprocess.Popen = fake_popen
        try:
            with self.assertRaises(Boom):
                rl.start_server("node", Path("/data"), 1234, ["/x/t3-server"])
        finally:
            rl.subprocess.Popen = original
        self.assertEqual(calls[0][:2], ["/x/t3-server", "serve"])
        self.assertEqual(calls[0][calls[0].index("--port") + 1], "1234")


class CliEnvironmentTest(unittest.TestCase):
    """T3GPUI_CLI_* for the installed `t3` shim (cliCommand.ts): the Rust binary's own path, no Node entry."""

    def test_the_main_app_against_the_real_rust_binary_gets_the_binary_and_node(self):
        from tools.run_local import cli_environment
        self.assertEqual(
            cli_environment("server", "rust", ["/x/t3code"], "/usr/bin/node", Path("/data/server")),
            {"T3GPUI_CLI_HOME": "/data/server", "T3GPUI_CLI_ENTRY": "/x/t3code", "T3GPUI_CLI_NODE": "/usr/bin/node"},
        )

    def test_node_is_omitted_when_there_is_no_system_node(self):
        from tools.run_local import cli_environment
        self.assertEqual(
            cli_environment("server", "rust", ["/x/t3code"], None, Path("/data/server")),
            {"T3GPUI_CLI_HOME": "/data/server", "T3GPUI_CLI_ENTRY": "/x/t3code"},
        )

    def test_a_test_or_hot_reload_data_name_gets_nothing(self):
        from tools.run_local import cli_environment
        self.assertEqual(cli_environment("rustsrv", "rust", ["/x/t3code"], "/usr/bin/node", Path("/data/rustsrv")), {})

    def test_a_t3gpui_server_override_gets_nothing_even_for_the_main_app(self):
        from tools.run_local import cli_environment
        self.assertEqual(cli_environment("server", "external", ["/x/custom"], "/usr/bin/node", Path("/data/server")), {})

    def test_a_multi_part_server_command_prefix_gets_nothing(self):
        from tools.run_local import cli_environment
        self.assertEqual(cli_environment("server", "rust", ["/usr/bin/node", "/x/wrapper.mjs"], "/usr/bin/node", Path("/data/server")), {})


if __name__ == "__main__":
    unittest.main()


class DesktopShellAndLinksTest(unittest.TestCase):
    """Ports of DesktopShellEnvironment.ts's merge and the bundle's link handlers."""

    def test_extracts_marked_values(self):
        from tools.run_local import extract_environment
        out = "noise\n__T3CODE_ENV_PATH_START__\n/a:/b\n__T3CODE_ENV_PATH_END__\n__T3CODE_ENV_LANG_START__\n__T3CODE_ENV_LANG_END__\n"
        self.assertEqual(extract_environment(out, ["PATH", "LANG", "JAVA_HOME"]), {"PATH": "/a:/b"})

    def test_login_shell_path_comes_first_and_dedupes(self):
        from tools.run_local import apply_login_shell_environment
        env = {"PATH": "/usr/bin:/opt/x", "SSH_AUTH_SOCK": "/keep"}
        apply_login_shell_environment(env, {"PATH": "/opt/homebrew/bin:/usr/bin", "SSH_AUTH_SOCK": "/other", "HOMEBREW_PREFIX": "/opt/homebrew"})
        self.assertEqual(env["PATH"], "/opt/homebrew/bin:/usr/bin:/opt/x")
        self.assertEqual(env["SSH_AUTH_SOCK"], "/keep")
        self.assertEqual(env["HOMEBREW_PREFIX"], "/opt/homebrew")
        self.assertEqual(env["LC_CTYPE"], "en_US.UTF-8")

    def test_locale_from_shell_when_unset(self):
        from tools.run_local import apply_login_shell_environment
        env = apply_login_shell_environment({"PATH": "/bin"}, {"LANG": "en_GB.UTF-8"})
        self.assertEqual(env["LANG"], "en_GB.UTF-8")
        self.assertNotIn("LC_CTYPE", env)

    def test_shell_candidates(self):
        from tools.run_local import login_shell_candidates
        self.assertEqual(login_shell_candidates("/bin/bash", "/bin/zsh"), ["/bin/bash", "/bin/zsh"])
        self.assertEqual(login_shell_candidates(None, ""), ["/bin/zsh"])

    def test_url_scheme_per_copy(self):
        from tools.run_local import app_url_scheme, link_handlers
        self.assertEqual(app_url_scheme(""), "t3code")
        self.assertEqual(app_url_scheme("deskfix"), "t3code-deskfix")
        self.assertEqual(app_url_scheme("vis4"), "t3code-vis")
        doc = link_handlers("")["CFBundleDocumentTypes"][0]
        self.assertEqual(doc["LSHandlerRank"], "Alternate")
        self.assertEqual(doc["CFBundleTypeExtensions"], ["html", "htm", "xhtml"])
