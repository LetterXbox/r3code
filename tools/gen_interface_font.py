#!/usr/bin/env python3
"""Cut fixed-weight files of the interface font from its variable source.

The GPUI host paints a variable font at its default instance, and Bricolage Grotesque's default is
opsz 96 / wght 800, so every text came out ExtraBold. The app therefore ships static cuts at the
text optical size (opsz 14, wdth 100), under a family name of their own so the host never resolves
to a system-installed variable copy instead.

    python3 tools/gen_interface_font.py
"""
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "tools" / "fonts-src" / "BricolageGrotesque-Variable.ttf"
OUT = ROOT / "t3ui" / "fonts"
FAMILY = "Bricolage Grotesque UI"
WEIGHTS = {"Regular": 400, "Medium": 500, "SemiBold": 600, "Bold": 700}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for style, weight in WEIGHTS.items():
        font = instantiateVariableFont(TTFont(SOURCE), {"opsz": 14, "wdth": 100, "wght": weight})
        name = font["name"]
        ribbi = style in {"Regular", "Bold"}
        postscript = f"{FAMILY.replace(' ', '')}-{style}"
        for record in list(name.names):
            if record.nameID in {16, 17, 21, 22, 25}:
                name.removeNames(nameID=record.nameID)
        for platform, encoding, language in ((3, 1, 0x409), (1, 0, 0)):
            name.setName(FAMILY if ribbi else f"{FAMILY} {style}", 1, platform, encoding, language)
            name.setName(style if ribbi else "Regular", 2, platform, encoding, language)
            name.setName(f"{FAMILY} {style}", 3, platform, encoding, language)
            name.setName(f"{FAMILY} {style}", 4, platform, encoding, language)
            name.setName(postscript, 6, platform, encoding, language)
        if not ribbi:
            name.setName(FAMILY, 16, 3, 1, 0x409)
            name.setName(style, 17, 3, 1, 0x409)
        font["OS/2"].usWeightClass = weight
        selection = font["OS/2"].fsSelection & ~0b1100001
        font["OS/2"].fsSelection = selection | (0b100000 if style == "Bold" else 0b1000000 if style == "Regular" else 0)
        font["head"].macStyle = 1 if style == "Bold" else 0
        font.save(OUT / f"BricolageGroteskUI-{style}.ttf")
        print(f"wrote {style} ({weight})")


if __name__ == "__main__":
    main()
