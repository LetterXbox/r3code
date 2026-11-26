import json
import struct
import tempfile
import unittest
import zipfile
from pathlib import Path

from tools import build_r3_windows


class BuildR3WindowsTests(unittest.TestCase):
    def test_windows_manifest_adds_windows_capabilities(self) -> None:
        base = json.loads((build_r3_windows.ROOT / "t3ui/nsh.json").read_text(encoding="utf-8"))
        adapted = build_r3_windows.windows_manifest(base)
        self.assertTrue(adapted["capabilities"]["windows"])
        self.assertTrue(adapted["capabilities"]["homeDir"])
        self.assertTrue(adapted["capabilities"]["application"])
        self.assertTrue(adapted["capabilities"]["notifications"])
        self.assertTrue(adapted["capabilities"]["audio"])
        self.assertIn("${homeDir}", adapted["capabilities"]["fs"]["read"])
        self.assertIn("${dataDir}", adapted["capabilities"]["fs"]["read"])
        self.assertIn("ssh.exe", adapted["capabilities"]["process"]["execute"])
        self.assertIn("USERPROFILE", adapted["capabilities"]["process"]["env"])
        self.assertIn("secureStorage.*", adapted["capabilities"]["host"])
        self.assertIn("dialogs.pickFiles", adapted["capabilities"]["host"])
        self.assertIn("r3.*", adapted["capabilities"]["host"])
        self.assertNotIn("ssh.exe", base["capabilities"]["process"]["execute"])

    def test_adapt_composer_for_v07_replaces_speech_import(self) -> None:
        composer = (build_r3_windows.ROOT / "t3ui/components/Composer.tsx").read_text(encoding="utf-8")
        adapted = build_r3_windows.adapt_composer_for_v07(composer)
        self.assertNotIn(", Speech,", adapted)
        self.assertIn("const Speech = {", adapted)

    def test_marker_value_ignores_crlf_line_endings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lf = Path(tmp) / "lf.patch"
            crlf = Path(tmp) / "crlf.patch"
            lf.write_bytes(b"line1\nline2\n")
            crlf.write_bytes(b"line1\r\nline2\r\n")
            self.assertEqual(build_r3_windows.marker_value(lf), build_r3_windows.marker_value(crlf))

    def test_extract_ico_from_icns_produces_valid_ico(self) -> None:
        icns = build_r3_windows.ROOT / "assets/r3-icon.icns"
        frames = build_r3_windows.extract_icns_pngs(icns)
        sizes = [dim for dim, _ in frames]
        self.assertIn(32, sizes)
        self.assertIn(64, sizes)
        self.assertIn(128, sizes)
        self.assertIn(256, sizes)
        with tempfile.TemporaryDirectory() as tmp:
            ico = Path(tmp) / "icon.ico"
            self.assertTrue(build_r3_windows.extract_ico_from_icns(icns, ico))
            raw = ico.read_bytes()
            reserved, kind, count = struct.unpack("<HHH", raw[:6])
            self.assertEqual((reserved, kind), (0, 1))
            self.assertEqual(count, len(frames))
            group = build_r3_windows.build_group_icon_resource(frames)
            self.assertEqual(len(group), 6 + 14 * len(frames))

    def test_stage_and_package_windows_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            stage_dir = tmp_path / "stage"
            identity = build_r3_windows.standalone_build_identity(build_r3_windows.ROOT)
            build_r3_windows.stage_windows_ui(stage_dir, build_r3_windows.ROOT, identity=identity)
            staged_manifest = json.loads((stage_dir / "nsh.json").read_text(encoding="utf-8"))
            self.assertIn("ssh.exe", staged_manifest["capabilities"]["process"]["execute"])
            self.assertFalse((stage_dir / "App.test.tsx").exists())
            self.assertTrue((stage_dir / "components/mcp/logos/claude.png").is_file())
            self.assertEqual((stage_dir / "i18n/translations/zh.json").read_text(encoding="utf-8").strip(), "{}")
            self.assertLess((stage_dir / "vendor/shiki/shiki.js").stat().st_size, 1024)
            self.assertLess((stage_dir / "vendor/mathjax/tex2svg.js").stat().st_size, 256)
            staged_schemas = json.loads((stage_dir / "backend/rpcResultSchemas.json").read_text(encoding="utf-8"))
            self.assertIn("vcs.listRefs", staged_schemas["methods"])
            self.assertGreater(len(staged_schemas["methods"]), 100)

            ui_dir = tmp_path / "ui"
            (ui_dir / "assets").mkdir(parents=True)
            (ui_dir / "bundle.nshc").write_bytes(b"bytecode")
            (ui_dir / "assets/sample.txt").write_text("ok", encoding="utf-8")
            fake_exe = tmp_path / "nsh-windows-app.exe"
            fake_exe.write_bytes(b"MZfake")
            final_exe = build_r3_windows.prepare_host_exe(fake_exe, tmp_path / "final.exe", root=build_r3_windows.ROOT, embed_icon=False)
            identity = build_r3_windows.standalone_build_identity(build_r3_windows.ROOT, host_exe=final_exe)

            out_dir = tmp_path / "R3 Code"
            zip_path = tmp_path / "R3-Code-windows-x64.zip"
            build_r3_windows.package_windows_bundle(
                ui_dir,
                final_exe,
                out_dir,
                identity=identity,
                root=build_r3_windows.ROOT,
                zip_path=zip_path,
                embed_icon=False,
            )
            self.assertTrue((out_dir / "R3 Code.exe").is_file())
            self.assertTrue((out_dir / "nsh/bundle.nshc").is_file())
            self.assertTrue((out_dir / "nsh/app.json").is_file())
            self.assertTrue((out_dir / "nsh/capabilities.json").is_file())
            self.assertTrue((out_dir / "nsh/icon.ico").is_file())
            self.assertTrue((out_dir / "nsh/assets/i18n/zh.json").is_file())
            self.assertTrue((out_dir / "LICENSE.txt").is_file())
            expected_sha = build_r3_windows.sha256_file(out_dir / "R3 Code.exe")
            packaged_identity = json.loads((out_dir / "nsh/build-identity.json").read_text(encoding="utf-8"))
            self.assertEqual(packaged_identity["hostExecutableSha256"], expected_sha)
            with zipfile.ZipFile(zip_path) as zf:
                names = set(zf.namelist())
                self.assertIn("R3 Code/R3 Code.exe", names)
                self.assertIn("R3 Code/nsh/bundle.nshc", names)
                self.assertIn("R3 Code/nsh/app.json", names)
                self.assertNotIn(f"R3 Code/{build_r3_windows.BUNDLE_MARKER}", names)
                archived_exe = zf.read("R3 Code/R3 Code.exe")
                archived_identity = json.loads(zf.read("R3 Code/nsh/build-identity.json").decode("utf-8"))
                self.assertEqual(
                    archived_identity["hostExecutableSha256"],
                    build_r3_windows.hashlib.sha256(archived_exe).hexdigest(),
                )

    def test_stage_and_package_reject_unsafe_paths_and_preserve_prior_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            with self.assertRaises(ValueError):
                build_r3_windows.stage_windows_ui(build_r3_windows.ROOT / "t3ui", build_r3_windows.ROOT)
            with self.assertRaises(ValueError):
                build_r3_windows.stage_windows_ui(build_r3_windows.ROOT, build_r3_windows.ROOT)

            unowned = tmp_path / "unowned"
            unowned.mkdir()
            (unowned / "user.txt").write_text("keep", encoding="utf-8")
            with self.assertRaises(ValueError):
                build_r3_windows.stage_windows_ui(unowned, build_r3_windows.ROOT)
            self.assertEqual((unowned / "user.txt").read_text(encoding="utf-8"), "keep")

            ui_dir = tmp_path / "ui"
            ui_dir.mkdir()
            (ui_dir / "bundle.nshc").write_bytes(b"v1")
            fake_exe = tmp_path / "host.exe"
            fake_exe.write_bytes(b"MZ1")
            out_dir = tmp_path / "R3 Code"

            with self.assertRaises(ValueError):
                build_r3_windows.package_windows_bundle(ui_dir, fake_exe, unowned, root=build_r3_windows.ROOT, embed_icon=False)
            self.assertEqual((unowned / "user.txt").read_text(encoding="utf-8"), "keep")

            build_r3_windows.package_windows_bundle(ui_dir, fake_exe, out_dir, root=build_r3_windows.ROOT, embed_icon=False)
            self.assertEqual((out_dir / "nsh/bundle.nshc").read_bytes(), b"v1")

            broken_ui = tmp_path / "broken-ui"
            broken_ui.mkdir()
            with self.assertRaises(FileNotFoundError):
                build_r3_windows.package_windows_bundle(broken_ui, fake_exe, out_dir, root=build_r3_windows.ROOT, embed_icon=False)
            self.assertEqual((out_dir / "nsh/bundle.nshc").read_bytes(), b"v1")


if __name__ == "__main__":
    unittest.main()
