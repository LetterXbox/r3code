import re
import tempfile
import unittest
from pathlib import Path

from tools import build_stage_art as bsa
from tools import build_theme as bt

ROOT = Path(__file__).resolve().parent.parent
HAVE_SOURCES = bt.INDEX_CSS.is_file() and bt.PALETTES_TS.is_file()
CHECKED_IN = ROOT / "t3ui" / "components" / "sidebar" / "stage"


@unittest.skipUnless(HAVE_SOURCES, "the reference checkout is not available")
class BuildStageArtTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.css_text = bt.INDEX_CSS.read_text()

    # --- resolving colours ------------------------------------------------------------------

    def test_ocean_matches_the_checked_in_svgs(self):
        """The generator re-derives Ocean (the checked-in default) from index.css byte for byte on
        colour: every hex it resolves for ocean/light and ocean/dark appears in the matching file."""
        for mode in ("light", "dark"):
            colors = bsa.resolve_theme_hex(self.css_text, "ocean", mode)
            nightly = (CHECKED_IN / f"nightly-{mode}.svg").read_text()
            blueprint = (CHECKED_IN / f"blueprint-{mode}.svg").read_text()
            for key in ("night_top", "night_mid", "night_bottom", "night_highlight",
                        "night_secondary", "night_tertiary", "night_line"):
                self.assertIn(colors[key], nightly, f"ocean {mode} {key}")
            for key in ("art_top", "art_mid", "art_bottom", "art_highlight", "art_secondary",
                        "art_tertiary", "art_line", "art_celeste_highlight", "art_celeste_secondary",
                        "art_violet_highlight", "art_grid_line"):
                self.assertIn(colors[key], blueprint, f"ocean {mode} {key}")

    def test_a_custom_theme_has_no_stage_colours(self):
        """themeAllowsSidebarArtwork is only true for the five built-ins in the reference: any other
        id (a custom theme) is not this generator's to colour."""
        self.assertIsNone(bsa.resolve_theme(self.css_text, "my-custom-theme", "light"))
        self.assertEqual(bsa.generate_for(self.css_text, "my-custom-theme", "my-custom-theme"), {})

    def test_nightly_light_and_dark_differ_under_ocean(self):
        """Ocean derives its night palette from its own (per-mode) art palette, so light and dark
        must not be the byte-identical fallback the port originally shipped."""
        light = bsa.resolve_theme_hex(self.css_text, "ocean", "light")
        dark = bsa.resolve_theme_hex(self.css_text, "ocean", "dark")
        self.assertNotEqual(light["night_top"], dark["night_top"])
        self.assertNotEqual(light["night_line"], dark["night_line"])

    def test_grove_and_ember_paint_their_night_palette_directly(self):
        """grove and ember set --stage-night-* themselves in index.css (not the color-mix rule the
        other three use): the resolved highlight must be their own value, not the art highlight."""
        for theme_id in ("grove", "ember"):
            for mode in ("light", "dark"):
                resolved = bsa.resolve_theme(self.css_text, theme_id, mode)
                self.assertNotEqual(resolved["night_highlight"], resolved["art_highlight"],
                                     f"{theme_id} {mode}")

    def test_t3_chat_ocean_iris_derive_night_from_art_by_color_mix(self):
        """The reference's :is(t3-chat, ocean, iris) rule aliases night-highlight to the art
        highlight exactly, and the generator must do the same."""
        for theme_id in ("t3-chat", "ocean", "iris"):
            for mode in ("light", "dark"):
                resolved = bsa.resolve_theme(self.css_text, theme_id, mode)
                self.assertEqual(resolved["night_highlight"], resolved["art_highlight"], f"{theme_id} {mode}")

    def test_celeste_violet_grid_alias_every_built_in_theme(self):
        """The reference's second :is(...) rule (all five built-ins) always aliases celeste/violet to
        the theme's own highlight/secondary and grid-line to its own line."""
        for theme_id in bt.BUILT_IN_IDS:
            for mode in ("light", "dark"):
                resolved = bsa.resolve_theme(self.css_text, theme_id, mode)
                self.assertEqual(resolved["art_celeste_highlight"], resolved["art_highlight"])
                self.assertEqual(resolved["art_celeste_secondary"], resolved["art_secondary"])
                self.assertEqual(resolved["art_violet_highlight"], resolved["art_highlight"])
                self.assertEqual(resolved["art_grid_line"], resolved["art_line"])

    def test_mix_oklch_matches_a_hand_computed_midpoint(self):
        white = (1.0, 0.0, 0.0)
        black = (0.0, 0.0, 180.0)
        mid = bsa.mix_oklch(white, 50, black)
        self.assertAlmostEqual(mid[0], 0.5, places=6)

    # --- generated markup ---------------------------------------------------------------------

    def test_stage_fade_combines_reference_mask_and_background_gradient(self):
        self.assertAlmostEqual(bsa.stage_fade_alpha(0.28), 1.0)
        self.assertAlmostEqual(bsa.stage_fade_alpha(0.40), 0.90)
        self.assertAlmostEqual(bsa.stage_fade_alpha(0.52), 0.70)
        self.assertAlmostEqual(bsa.stage_fade_alpha(0.64), (0.92 - 0.64) / 0.37 * 0.42)
        self.assertAlmostEqual(bsa.stage_fade_alpha(0.85), (0.92 - 0.85) / 0.37 * 0.04)
        self.assertEqual(bsa.stage_fade_alpha(0.92), 0.0)

    def test_generated_svgs_keep_the_blur_mask_and_pattern(self):
        colors = bsa.resolve_theme_hex(self.css_text, "iris", "dark")
        nightly = bsa.render_nightly(colors, "iris", "dark")
        blueprint = bsa.render_blueprint(colors, "iris", "dark")
        self.assertIn("feGaussianBlur", nightly)
        self.assertIn("<mask", nightly)
        self.assertIn("<pattern", nightly)
        self.assertIn("<mask", blueprint)
        self.assertIn("<pattern", blueprint)

    def test_no_svg_comment_contains_a_double_dash(self):
        """nsh build refuses an SVG whose comment contains `--`."""
        colors = bsa.resolve_theme_hex(self.css_text, "ember", "light")
        for text in (bsa.render_nightly(colors, "ember", "light"), bsa.render_blueprint(colors, "ember", "light")):
            for comment in re.findall(r"<!--(.*?)-->", text, re.DOTALL):
                self.assertNotIn("--", comment)

    def test_different_themes_produce_different_colours(self):
        ocean = bsa.render_nightly(bsa.resolve_theme_hex(self.css_text, "ocean", "dark"), "ocean", "dark")
        ember = bsa.render_nightly(bsa.resolve_theme_hex(self.css_text, "ember", "dark"), "ember", "dark")
        self.assertNotEqual(ocean, ember)

    # --- every theme's art, checked in for a live theme switch ---------------------------------

    def test_checked_in_variants_are_what_the_generator_writes(self):
        """SidebarStageBackdrop.tsx picks stage/themes/<id>-<art>-<mode>.svg by the theme showing, so a
        live theme.setOverrides repaints the art with no rebuild. Those files must be the generator's
        output for the reference's current index.css, byte for byte, and nothing else may sit there."""
        variants = bsa.generate_variants(self.css_text)
        self.assertEqual(len(variants), len(bsa.ART_THEME_IDS) * 4)
        for name, content in variants.items():
            self.assertEqual((CHECKED_IN / name).read_text(), content,
                             f"{name} is stale: python3 tools/build_stage_art.py --all --out {CHECKED_IN}")
        on_disk = sorted(f"{bsa.VARIANT_DIR}/{path.name}" for path in (CHECKED_IN / bsa.VARIANT_DIR).iterdir())
        self.assertEqual(on_disk, sorted(variants))

    def test_the_stage_art_index_imports_every_variant(self):
        index = (CHECKED_IN / "stageArt.ts").read_text()
        for name in bsa.generate_variants(self.css_text):
            self.assertIn(f'"./{name}"', index)

    def test_button_art_is_the_unfaded_compact_reference_slice(self):
        variants = bsa.generate_button_variants(self.css_text)
        self.assertEqual(len(variants), len(bsa.ART_THEME_IDS) * 4)
        index = (CHECKED_IN / "stageButtonArt.ts").read_text()
        for name, svg in variants.items():
            offset = 96 if "-nightly-" in name else 64
            self.assertIn(f'viewBox="{offset} 0 96 96"', svg)
            self.assertNotIn('<g mask="url(#fadeMask)">', svg)
            self.assertIn('width="8192" height="96"', svg)
            self.assertEqual((CHECKED_IN / name).read_text(), svg)
            self.assertIn(f'"./{name}"', index)

    def test_every_theme_and_mode_paints_its_own_art(self):
        variants = bsa.generate_variants(self.css_text)
        self.assertEqual(len(set(variants.values())), len(variants))

    def test_the_standard_theme_paints_roots_own_values(self):
        """"default" (the standard T3 Code theme) has no html[data-theme-id] rule: it shows `:root`'s
        own stage colours, with none of the built-ins' aliasing and the night sky on the night base."""
        light = bsa.resolve_theme(self.css_text, "default", "light")
        dark = bsa.resolve_theme(self.css_text, "default", "dark")
        self.assertEqual(light["art_top"], (0.782169, 0.123386, 240.226))
        self.assertEqual(dark["art_top"], (0.581473, 0.149124, 256.9))
        # Only the three paper stops have a dark value; everything else is shared.
        self.assertEqual(light["art_line"], dark["art_line"])
        self.assertEqual(light["night_top"], bsa.night_base(self.css_text)["top"])
        self.assertEqual(light["night_top"], dark["night_top"])
        self.assertNotEqual(light["art_celeste_highlight"], light["art_highlight"])
        self.assertNotEqual(light["night_sparkle"], light["night_line"])

    def test_write_variants_writes_into_the_themes_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            written = bsa.write_variants(Path(tmp), self.css_text)
            self.assertEqual(len(written), 24)
            self.assertTrue((Path(tmp) / "themes" / "ember-nightly-dark.svg").is_file())

    # --- writing into a staged copy ------------------------------------------------------------

    def test_write_stage_art_writes_only_the_coloured_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            stage_dir = Path(tmp) / "stage"
            written = bsa.write_stage_art(stage_dir, "grove", "my-custom-theme", self.css_text)
            # grove (light) is a built-in; the custom id (dark) is left alone, so only the light pair
            # is written.
            self.assertEqual(written, ["blueprint-light.svg", "nightly-light.svg"])
            self.assertFalse((stage_dir / "nightly-dark.svg").exists())

    def test_stage_theme_build_repaints_the_staged_art(self):
        """End to end, through build_theme.stage_theme_build: a themed request for a built-in pair
        other than Ocean must leave the staged copy's stage art different from the checked-in one."""
        sources = bt.Sources()
        request = bt.normalize_request({"themeLight": "ember", "themeDark": "iris"})
        with tempfile.TemporaryDirectory() as tmp:
            stage_dir = Path(tmp) / "staged"
            bt.stage_theme_build(ROOT / "t3ui" / "App.tsx", stage_dir, request, sources)
            staged = stage_dir / "components" / "sidebar" / "stage"
            self.assertNotEqual((staged / "nightly-light.svg").read_text(),
                                 (CHECKED_IN / "nightly-light.svg").read_text())
            self.assertNotEqual((staged / "blueprint-dark.svg").read_text(),
                                 (CHECKED_IN / "blueprint-dark.svg").read_text())
            # The repo's own files are never touched.
            self.assertEqual((CHECKED_IN / "nightly-light.svg").read_text(),
                              (ROOT / "t3ui" / "components" / "sidebar" / "stage" / "nightly-light.svg").read_text())


if __name__ == "__main__":
    unittest.main()
