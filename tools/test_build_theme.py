import json
from pathlib import Path
import tempfile
import time
import unittest

from tools import build_theme as bt

ROOT = Path(__file__).resolve().parent.parent
HAVE_SOURCES = bt.INDEX_CSS.is_file() and bt.PALETTES_TS.is_file()


def rgb(value):
    return tuple(int(part) for part in value[4:-1].split(","))


@unittest.skipUnless(HAVE_SOURCES, "the reference checkout is not available")
class BuildThemeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sources = bt.Sources()

    def build(self, **fields):
        request = bt.normalize_request({"themeLight": "ocean", "themeDark": "ocean", **fields})
        return bt.build_theme(request, self.sources)[0]["cssVars"]

    def test_default_request_is_the_checked_in_ocean_theme(self):
        theme, meta = bt.build_theme(bt.normalize_request({}), self.sources)
        self.assertEqual(theme, json.loads((ROOT / "t3ui" / "theme.json").read_text()))
        self.assertEqual(meta, {"light": "ocean", "dark": "ocean", "contrast": 100})

    def test_ocean_dark_matches_the_reference_surfaces_measured_on_screen(self):
        dark = self.build()["dark"]
        close = lambda value, expected: all(abs(a - b) <= 1 for a, b in zip(rgb(value), expected))
        # The palette footer (bg-foreground/[0.025]) and its keycaps, a settings keycap (bg-foreground/[0.07]), and the
        # segmented control's track (bg-input/40) and pressed item (bg-input/72), sampled from the reference captures.
        self.assertTrue(close(dark["command-footer"], (29, 37, 48)), dark["command-footer"])
        self.assertTrue(close(dark["kbd-key"], (39, 48, 58)), dark["kbd-key"])
        self.assertTrue(close(dark["segmented-track"], (45, 61, 75)), dark["segmented-track"])
        self.assertTrue(close(dark["segmented-active"], (69, 91, 109)), dark["segmented-active"])
        self.assertGreater(sum(rgb(dark["segmented-active"])), sum(rgb(dark["segmented-track"])))
        # A dialog footer (bg-muted/72) is the page colour nudged toward muted, never the lighter popover slate.
        self.assertLess(sum(rgb(dark["muted-72"])), sum(rgb(dark["popover"])))

    def test_translucent_input_keeps_its_alpha_in_segmented_controls(self):
        raw = bt.apply_contrast(dict(self.sources.base["dark"]), 150, "dark")
        background = bt.parse_color(raw["background"])[:3]
        input_color = bt.parse_color(raw["input"])
        flattened = bt.flatten_tokens(raw)
        expected_track = tuple(round(f * input_color[3] * 0.4 + b * (1 - input_color[3] * 0.4)) for f, b in zip(input_color[:3], background))
        self.assertEqual(rgb(flattened["segmented-track"]), expected_track)
        self.assertLess(max(rgb(flattened["segmented-active"])), 100)

    def test_draft_row_and_glass_surfaces_follow_the_reference_classes(self):
        dark = self.build()["dark"]
        over = lambda front, back, a: tuple(round(f * a + b * (1 - a)) for f, b in zip(rgb(front), rgb(back)))
        # draftSurfaceClassName = "bg-warning/4 hover:bg-warning/8" over the sidebar.
        grain = "rgb(%d,%d,%d)" % tuple(round(128 * 0.035 + c * 0.965) for c in rgb(dark["sidebar"]))
        close = lambda a, b: all(abs(x - y) <= 1 for x, y in zip(a, b))
        self.assertTrue(close(rgb(dark["warning-4"]), over(dark["warning"], grain, 0.04)), dark["warning-4"])
        self.assertTrue(close(rgb(dark["warning-8"]), over(dark["warning"], grain, 0.08)), dark["warning-8"])
        # About #29343b: the reference's bg-warning/4 over the sidebar surface as measured on screen.
        self.assertTrue(all(abs(x - y) <= 2 for x, y in zip(rgb(dark["warning-4"]), (41, 52, 59))), dark["warning-4"])
        self.assertNotIn("warning-20", dark)
        # dropdown-glass (menus, popovers, glass toasts): the popover token at 18% plus 82% of 80% over the page.
        alpha = 0.18 + 0.82 * 0.8
        self.assertTrue(all(abs(a - b) <= 1 for a, b in zip(rgb(dark["popover-84"]), over(dark["popover"], dark["background"], alpha))))

    def test_every_theme_emits_the_same_tokens_with_the_font_and_flattened_alpha(self):
        reference = self.build()
        for theme_id in ("default", *bt.BUILT_IN_IDS):
            with self.subTest(theme=theme_id):
                css_vars = self.build(themeLight=theme_id, themeDark=theme_id)
                for mode in ("light", "dark"):
                    self.assertEqual(set(css_vars[mode]), set(reference[mode]))
                    for name in ("card-40", "border-60", "border-70", "muted-50", "info-40", "details-card-border", "provider-row-hover"):
                        self.assertIn(name, css_vars[mode])
                self.assertTrue(css_vars["theme"]["font-sans"].startswith('"Bricolage Grotesque UI"'))

    def test_light_and_dark_take_their_own_theme(self):
        mixed = self.build(themeLight="grove", themeDark="ember")
        self.assertEqual(mixed["light"]["background"], self.build(themeLight="grove", themeDark="grove")["light"]["background"])
        self.assertEqual(mixed["dark"]["background"], self.build(themeLight="ember", themeDark="ember")["dark"]["background"])
        self.assertNotEqual(mixed["light"]["background"], mixed["dark"]["background"])
        self.assertNotEqual(self.build(themeDark="grove")["dark"]["background"], self.build()["dark"]["background"])

    def test_flattened_tokens_follow_the_chosen_theme(self):
        dark = self.build(themeLight="iris", themeDark="iris")["dark"]
        background, card, border = rgb(dark["background"]), rgb(dark["card"]), rgb(dark["border"])
        self.assertEqual(rgb(dark["card-40"]), tuple(round(c * 0.4 + b * 0.6) for c, b in zip(card, background)))
        self.assertEqual(rgb(dark["border-60"]), tuple(round(f * 0.6 + b * 0.4) for f, b in zip(border, card)))

    def test_contrast_100_changes_nothing_and_the_rest_moves_text_and_lines(self):
        base = self.build()
        self.assertEqual(self.build(contrast=100), base)
        dark_background = rgb(base["dark"]["background"])
        high, low = self.build(contrast=150)["dark"], self.build(contrast=50)["dark"]
        # Boost above 100 pushes foregrounds toward white in dark and black in light; below 100 they fade
        # toward the surface they sit on. Lines get stronger with the boost.
        self.assertGreater(sum(rgb(high["muted-foreground"])), sum(rgb(base["dark"]["muted-foreground"])))
        self.assertLess(sum(rgb(low["muted-foreground"])), sum(rgb(base["dark"]["muted-foreground"])))
        self.assertLess(sum(abs(a - b) for a, b in zip(rgb(low["foreground"]), dark_background)),
                        sum(abs(a - b) for a, b in zip(rgb(base["dark"]["foreground"]), dark_background)))
        self.assertLess(sum(rgb(self.build(contrast=150)["light"]["foreground"])), sum(rgb(base["light"]["foreground"])))
        self.assertGreater(sum(rgb(high["border"])), sum(rgb(base["dark"]["border"])))
        self.assertEqual(self.build(contrast=200)["dark"]["foreground"], "rgb(255,255,255)")
        # Surfaces are not contrast tokens.
        self.assertEqual(high["background"], base["dark"]["background"])
        # The flattened tokens are computed from the adjusted line colour.
        self.assertNotEqual(high["border-60"], base["dark"]["border-60"])

    def test_a_custom_theme_paints_over_the_t3_chat_defaults(self):
        # parseThemeFile fills the roles a theme file leaves out from getDefaultThemeColors (T3 Chat), not the standard palette.
        custom = {"id": "midnight", "label": "Midnight", "appearance": "dark", "colors": {"canvas": "#010203", "messageAction": "#ff0000"}}
        request = bt.normalize_request({"themeLight": "ocean", "themeDark": "midnight", "customThemes": [custom]})
        dark = bt.build_theme(request, self.sources)[0]["cssVars"]["dark"]
        self.assertEqual(dark["background"], "rgb(1,2,3)")
        self.assertEqual(dark["primary"], "rgb(255,0,0)")
        chat = self.sources.palettes["t3-chat"]["variants"]["dark"]["text"]
        self.assertEqual(dark["foreground"], bt.fmt(bt.parse_color(chat)))

    def test_editor_preview_full_palette_uses_real_generator_without_changing_other_mode(self):
        colors = dict(self.sources.palettes["ocean"]["variants"]["dark"])
        colors["canvas"] = "#123456"
        preview = {"id": "r3-editor-preview", "label": "Editor preview", "appearance": "dark", "colors": colors}
        request = bt.normalize_request({"themeLight": "grove", "themeDark": preview["id"], "contrast": 150, "customThemes": [preview]})
        css = bt.build_theme(request, self.sources)[0]["cssVars"]
        self.assertEqual(css["dark"]["background"], "rgb(18,52,86)")
        self.assertEqual(css["light"], self.build(themeLight="grove", contrast=150)["light"])

    def test_a_light_and_dark_custom_theme_paints_each_mode_from_its_own_palette(self):
        custom = {"id": "duo", "label": "Duo", "appearance": "light", "colors": {"canvas": "#fafafa", "accent": "#112233"},
                  "variants": {"dark": {"canvas": "#050607", "accent": "#445566"}}, "collection": {"id": "open-vsx:a.b", "label": "Duo"}}
        request = bt.normalize_request({"themeLight": "duo", "themeDark": "duo", "customThemes": [custom]})
        css = bt.build_theme(request, self.sources)[0]["cssVars"]
        self.assertEqual(css["light"]["background"], "rgb(250,250,250)")
        self.assertEqual(css["dark"]["background"], "rgb(5,6,7)")
        # A change to the variant alone changes what a build shows.
        other = dict(custom, variants={"dark": {"canvas": "#050607", "accent": "#778899"}})
        again = bt.normalize_request({"themeLight": "duo", "themeDark": "duo", "customThemes": [other]})
        self.assertNotEqual(bt.effective(request), bt.effective(again))
        self.assertEqual(bt.effective(request)["customs"][0]["collection"], {"id": "open-vsx:a.b", "label": "Duo"})

    def test_a_theme_with_only_one_palette_paints_it_in_both_modes(self):
        custom = {"id": "solo", "label": "Solo", "appearance": "dark", "colors": {"canvas": "#0a0b0c"}}
        css = self.build(themeLight="solo", themeDark="solo", customThemes=[custom])
        self.assertEqual(css["light"]["background"], "rgb(10,11,12)")
        self.assertEqual(css["dark"]["background"], "rgb(10,11,12)")

    def test_a_full_role_theme_overrides_every_role_the_generator_maps(self):
        # Every role of the reference palette, each set to a distinct colour: every mapped token takes its role's colour.
        roles = list(self.sources.palettes["t3-chat"]["colors"])
        colors = {role: "#%02x%02x%02x" % (16 + index * 3, 40 + index * 2, 200 - index) for index, role in enumerate(roles)}
        custom = {"id": "full", "label": "Full", "appearance": "dark", "colors": colors}
        dark = self.build(themeDark="full", customThemes=[custom])["dark"]
        for token, role in bt.ROLES.items():
            expected = bt.fmt(bt.parse_color(colors[role]))
            self.assertEqual(dark[token], expected, f"{token} <- {role}")

    def test_oklch_colours_in_a_theme_file_are_read(self):
        custom = {"id": "chroma", "label": "Chroma", "appearance": "dark", "colors": {"canvas": "oklch(0.2 0.02 250)"}}
        dark = self.build(themeDark="chroma", customThemes=[custom])["dark"]
        self.assertEqual(dark["background"], bt.fmt(bt.parse_color("oklch(0.2 0.02 250)")))

    def test_bad_requests_are_rejected(self):
        for raw in ({"contrast": 49}, {"contrast": 201}, {"contrast": 120.5}, {"themeDark": "No Such"}, {"customThemes": [{"id": "ocean"}]},
                    {"customThemes": [{"id": "x", "label": "X", "appearance": "dark", "colors": {"canvas": "red"}}]},
                    {"customThemes": [{"id": "x", "label": "X", "appearance": "dark", "colors": {}, "variants": {"dark": {}}}]},
                    {"customThemes": [{"id": "x", "label": "X", "appearance": "dark", "colors": {}, "collection": {"id": 1}}]}, []):
            with self.subTest(raw=raw), self.assertRaises(bt.ThemeError):
                bt.normalize_request(raw)
        with self.assertRaises(bt.ThemeError):
            self.build(themeDark="never-heard-of-it")

    def test_effective_ignores_unused_custom_themes_and_the_request_id(self):
        custom = {"id": "midnight", "label": "Midnight", "appearance": "dark", "colors": {"canvas": "#010203"}}
        a = bt.normalize_request({"requestId": "1", "customThemes": [custom]})
        b = bt.normalize_request({"requestId": "2"})
        self.assertEqual(bt.effective(a), bt.effective(b))
        self.assertNotEqual(bt.effective(a), bt.effective(bt.normalize_request({"contrast": 110})))


@unittest.skipUnless(HAVE_SOURCES, "the reference checkout is not available")
class LiveThemeWatcherTest(unittest.TestCase):
    """The live-apply fast path (third_party/nsh-host/README.md "live theme"): a request written to
    LIVE_REQUEST_FILE is picked up far faster than the rebuild loop's cadence and answered in
    LIVE_RESULT_FILE / LIVE_STATUS_FILE, without ever touching REQUEST_FILE/STATUS_FILE (the slow
    rebuild loop's own files, which `LauncherThemes.changed()` watches)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.bootstrap = Path(self._tmp.name)
        self.sources = bt.Sources()
        self.watcher = bt.LiveThemeWatcher(self.bootstrap, lambda: self.sources)
        self.watcher.start()
        self.addCleanup(self.watcher.stop)

    def write_request(self, **fields):
        body = {"themeLight": "ocean", "themeDark": "ocean", "contrast": 100, "requestId": "live-1", **fields}
        (self.bootstrap / bt.LIVE_REQUEST_FILE).write_text(json.dumps(body))

    def wait_for_status(self, request_id: str, timeout: float = 5.0):
        deadline = time.monotonic() + timeout
        path = self.bootstrap / bt.LIVE_STATUS_FILE
        while time.monotonic() < deadline:
            try:
                status = json.loads(path.read_text())
            except (OSError, ValueError):
                status = None
            if status and status.get("requestId") == request_id:
                return status
            time.sleep(bt.LiveThemeWatcher.POLL_SECONDS)
        raise AssertionError(f"no status for {request_id!r} within {timeout}s")

    def test_a_live_request_is_answered_without_touching_the_rebuild_files(self):
        self.write_request(themeDark="grove", requestId="live-1")
        status = self.wait_for_status("live-1")
        self.assertTrue(status["ok"], status)
        result = json.loads((self.bootstrap / bt.LIVE_RESULT_FILE).read_text())
        self.assertEqual(result["requestId"], "live-1")
        self.assertEqual(result["meta"], {"light": "ocean", "dark": "grove", "contrast": 100})
        self.assertIn("cssVars", result["theme"])
        self.assertFalse((self.bootstrap / bt.REQUEST_FILE).exists())
        self.assertFalse((self.bootstrap / bt.STATUS_FILE).exists())

    def test_a_bad_live_request_is_reported_and_does_not_kill_the_watcher(self):
        (self.bootstrap / bt.LIVE_REQUEST_FILE).write_text("{not json")
        status = self.wait_for_status("")
        self.assertFalse(status["ok"])
        # The watcher thread is still alive and answers a good request after the bad one.
        self.write_request(themeDark="iris", requestId="live-2")
        status = self.wait_for_status("live-2")
        self.assertTrue(status["ok"], status)


@unittest.skipUnless(HAVE_SOURCES, "the reference checkout is not available")
class StartPrefersLastFileTest(unittest.TestCase):
    """`LauncherThemes.start()` reads LAST_FILE before REQUEST_FILE, so a choice the live path
    persisted (which never writes REQUEST_FILE) still applies to the next launch's first build."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        base = Path(self._tmp.name)
        self.bootstrap = base / "bootstrap"
        self.bootstrap.mkdir()
        self.themes = bt.LauncherThemes(self.bootstrap, base / "theme-stage", ROOT / "t3ui" / "App.tsx")

    def test_last_file_alone_is_applied_on_start(self):
        body = json.dumps({"themeLight": "ocean", "themeDark": "ember", "contrast": 100, "requestId": "last-1"})
        (self.bootstrap / bt.LAST_FILE).write_text(body)
        self.themes.start()
        self.assertEqual(self.themes.meta, {"light": "ocean", "dark": "ember", "contrast": 100})
        self.assertFalse((self.bootstrap / bt.REQUEST_FILE).exists())

    def test_last_file_wins_over_an_older_request_file(self):
        (self.bootstrap / bt.REQUEST_FILE).write_text(json.dumps(
            {"themeLight": "ocean", "themeDark": "grove", "contrast": 100, "requestId": "req-1"}))
        (self.bootstrap / bt.LAST_FILE).write_text(json.dumps(
            {"themeLight": "ocean", "themeDark": "ember", "contrast": 100, "requestId": "last-1"}))
        self.themes.start()
        self.assertEqual(self.themes.meta["dark"], "ember")


if __name__ == "__main__":
    unittest.main()
