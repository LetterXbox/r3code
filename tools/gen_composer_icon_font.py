#!/usr/bin/env python3
"""Builds t3ui/fonts/ComposerTokenIcons.ttf: the composer's inline token icons as glyphs.

The rich editor on the GPUI host draws no widget decorations, so each token's icon is a
character of this font at the start of the token's text, in the token's ink. The glyphs are
the Lucide SVGs under t3ui/components/composer/editor/icons (the reference's chip icons),
their strokes outlined with picosvg, on the metrics of Bricolage Grotesque UI (1000 upm,
ascent 930, descent -270) so they sit on the text's baseline, 1em square and centered on
the line like the chip's `[&_svg]:size-[1em] self-center`, followed by the chip's 0.2em gap.

Needs picosvg and fontTools (a venv: workspace/.venv-icons).
Run: workspace/.venv-icons/bin/python tools/gen_composer_icon_font.py
"""
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.svgLib.path import parse_path
from picosvg.svg import SVG

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "t3ui/components/composer/editor/icons"
OUT = ROOT / "t3ui/fonts/ComposerTokenIcons.ttf"
FAMILY = "Composer Token Icons"
BASE = ROOT / "t3ui/fonts/BricolageGroteskUI-Regular.ttf"

# Codepoint (Supplementary Private Use Area-A, U+F0000..) per token kind: the BMP PUA (U+E000..) holds glyphs of
# -apple-system (SF), which the text stack tries before this font and which drew in place of ours; keep in step with editor/tokenGlyphs.ts.
GLYPHS = [
    ("skill", 0xFF000, "box.svg"),
    ("file", 0xFF001, "file.svg"),
    ("folder", 0xFF002, "folder.svg"),
    ("model", 0xFF003, "model.svg"),
    ("pull-request", 0xFF004, "pull-request.svg"),
    ("thread", 0xFF005, "thread.svg"),
    ("terminal", 0xFF006, "terminal.svg"),
    ("preview-annotation", 0xFF007, "preview-annotation.svg"),
    ("citation", 0xFF008, "quote.svg"),
    # Per-file-type marks (components/files/fileIcons.ts FileGlyph); keep in step with editor/tokenGlyphs.ts.
    ("image", 0xFF010, "../../../files/icons/image.svg"),
    ("file-code", 0xFF011, "../../../files/icons/file-code.svg"),
    ("file-text", 0xFF012, "../../../files/icons/file-text.svg"),
    ("file-terminal", 0xFF013, "../../../files/icons/file-terminal.svg"),
    ("file-spreadsheet", 0xFF014, "../../../files/icons/file-spreadsheet.svg"),
    ("file-cog", 0xFF015, "../../../files/icons/file-cog.svg"),
    ("file-archive", 0xFF016, "../../../files/icons/file-archive.svg"),
    ("film", 0xFF017, "../../../files/icons/film.svg"),
    ("database", 0xFF018, "../../../files/icons/database.svg"),
]

UPM = 1000
ASCENT, DESCENT = 930, -270
ICON = 1000  # 1em
GAP = 200  # gap-[0.2em]
# Centered on the line box between ascent and descent (self-center).
BOTTOM = (ASCENT + DESCENT) / 2 - ICON / 2


def outline(svg_path: Path) -> str:
    text = svg_path.read_text().replace('stroke="#a3a3a3"', 'stroke="currentColor"')
    pico = SVG.fromstring(text).topicosvg()
    return " ".join(path.d for path in pico.shapes())


def glyph(d: str):
    pen = TTGlyphPen(None)
    scale = ICON / 24
    # SVG y grows down; font y grows up.
    transform = TransformPen(Cu2QuPen(pen, max_err=1.0, reverse_direction=True), (scale, 0, 0, -scale, 0, BOTTOM + ICON))
    parse_path(d, transform)
    return pen.glyph()


def lsb(g) -> int:
    """Left side bearing: the glyph's xMin, which hmtx must agree with (CoreText and FreeType read both)."""
    if g.numberOfContours == 0:
        return 0
    g.recalcBounds(None)
    return g.xMin


def main():
    """The icons are added to a copy of Bricolage Grotesque UI Regular, so one font serves the token's label and its icon.

    The host picks a font for a text run from the first family of the stack and does not fall through to a later family for a
    glyph the first lacks (the missing icon drew as a "?" box), so the icon font has to be the first family AND carry the
    label's letters: the token's text is drawn in this font alone.
    """
    font = TTFont(BASE)
    glyf, hmtx = font["glyf"], font["hmtx"]
    order = list(font.getGlyphOrder())
    new_cmap = {}
    for name, code, file in GLYPHS:
        g = glyph(outline(ICONS / file))
        glyf[name] = g
        order.append(name)
        hmtx[name] = (ICON + GAP, lsb(g))
        new_cmap[code] = name
    font.setGlyphOrder(order)
    glyf.glyphOrder = order
    table = font["cmap"]
    # A supplementary-plane subtable (format 12) carries the icons; the BMP ones stay as they were.
    bmp = {c: n for c, n in table.getBestCmap().items()}
    bmp.update(new_cmap)
    for sub in list(table.tables):
        if sub.format == 4:
            sub.cmap = {c: n for c, n in sub.cmap.items()}
    wide = CmapSubtable.newSubtable(12)
    wide.platformID, wide.platEncID, wide.language, wide.cmap = 3, 10, 0, bmp
    table.tables = [t for t in table.tables if t.format == 4 and (t.platformID, t.platEncID) != (3, 10)] + [wide]
    names = font["name"]
    for rec in list(names.names):
        if rec.nameID in (1, 16):
            rec.string = FAMILY
        elif rec.nameID in (3, 4, 6, 17, 2):
            continue
    names.setName(FAMILY, 1, 3, 1, 0x409)
    names.setName("Regular", 2, 3, 1, 0x409)
    names.setName("ComposerTokenIcons-Regular;1.0", 3, 3, 1, 0x409)
    names.setName(f"{FAMILY} Regular", 4, 3, 1, 0x409)
    names.setName("ComposerTokenIcons-Regular", 6, 3, 1, 0x409)
    names.names = [r for r in names.names if r.nameID not in (16, 17, 25) and not (r.platformID == 1)]
    font["post"].formatType = 2.0
    font["post"].extraNames = []
    font["post"].mapping = {}
    font["maxp"].numGlyphs = len(order)
    font.save(OUT)
    print(f"wrote {OUT} ({len(GLYPHS)} icon glyphs on {len(order) - len(GLYPHS)} text glyphs)")


if __name__ == "__main__":
    main()
