import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools import build_theme
from tools.rebuild_r3_app import prepare_host_sources, read_saved_theme, select_build_theme, validate_host


class RebuildThemeTest(unittest.TestCase):
    def test_host_build_applies_all_runtime_fixes_and_fails_on_patch_error(self):
        with patch("tools.rebuild_r3_app.subprocess.run") as run:
            prepare_host_sources()
        names = [Path(call.args[0][1]).name for call in run.call_args_list]
        self.assertEqual(names, [f"apply_nsh_{name}_patch.py" for name in (
            "clipboard_image", "keyed_list", "macos_drop", "markdown_table", "scroll_gesture", "titlebar_inset", "trailing_space", "webview_background", "macos_momentum", "macos_drop_read", "websocket_large", "focus_modifiers", "macos_about", "window_title", "wait_for_ui", "wait_for_ui_error", "dashed_border", "backdrop_blur",
        )])
        self.assertTrue(all(call.kwargs["check"] for call in run.call_args_list))

    def test_packaging_rejects_a_host_without_both_startup_options(self):
        with tempfile.TemporaryDirectory() as temporary:
            host = Path(temporary) / "host"
            host.write_bytes(b"--window-title")
            with self.assertRaisesRegex(RuntimeError, "lacks R3's startup options"):
                validate_host(host)
            host.write_bytes(b"--window-title\0--wait-for-ui")
            validate_host(host)

    def test_uses_saved_theme_and_contrast(self):
        with tempfile.TemporaryDirectory() as temporary:
            request = Path(temporary) / "theme-last.json"
            request.write_text(json.dumps({"themeLight": "ember", "themeDark": "default", "contrast": 150}))
            saved = read_saved_theme(request)
            self.assertEqual((saved["themeLight"], saved["themeDark"], saved["contrast"]), ("ember", "default", 150))

    def test_release_default_does_not_embed_the_builders_saved_theme(self):
        with tempfile.TemporaryDirectory() as temporary:
            request = Path(temporary) / "theme-last.json"
            request.write_text(json.dumps({"themeLight": "ember", "themeDark": "default", "contrast": 150}))
            self.assertEqual(select_build_theme(request, default_theme=True), build_theme.default_request())
            self.assertEqual(select_build_theme(request, default_theme=False)["contrast"], 150)

    def test_missing_choice_uses_default_but_invalid_choice_is_not_silently_reset(self):
        with tempfile.TemporaryDirectory() as temporary:
            request = Path(temporary) / "theme-last.json"
            self.assertEqual(read_saved_theme(request), build_theme.default_request())
            request.write_text('{"contrast": 999}')
            with self.assertRaises(build_theme.ThemeError):
                read_saved_theme(request)


if __name__ == "__main__":
    unittest.main()
