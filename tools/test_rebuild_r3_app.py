import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools import build_theme, prepare_nsh_host
from tools.rebuild_r3_app import DEFAULT_HOST_SOURCE, read_saved_theme, select_build_theme, validate_host


class RebuildThemeTest(unittest.TestCase):
    def test_default_host_source_uses_the_patched_tree_as_its_cache_key(self):
        self.assertEqual(DEFAULT_HOST_SOURCE.name, prepare_nsh_host.PATCHED_TREE)

    def test_prepared_host_rejects_edits_to_the_pinned_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            checkout = Path(temporary)
            git = ["git", "-C", temporary]
            subprocess.run([*git, "init", "--quiet"], check=True)
            (checkout / ".git/r3-prepared-host").write_text(prepare_nsh_host.NSH_COMMIT)
            source = checkout / "source"
            source.write_text("pinned")
            subprocess.run([*git, "add", "source"], check=True)
            tree = subprocess.check_output([*git, "write-tree"], text=True).strip()
            with patch.object(prepare_nsh_host, "PATCHED_TREE", tree):
                prepare_nsh_host.verify_prepared_host(checkout)
                source.write_text("edited")
                with self.assertRaisesRegex(ValueError, "differs from the pinned patched source"):
                    prepare_nsh_host.verify_prepared_host(checkout)

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
