#!/usr/bin/env python3
"""Apply T3's built-in Ocean palette to the NSH theme.

The reference desktop is using Ocean. This is the default theme of the port: the generator for every
theme and contrast is tools/build_theme.py, and this script is its Ocean, contrast 100 entry point,
kept so the documented flow still works:

    python3 tools/apply_ocean_theme.py <themePalettes.ts> <t3ui/theme.json>

It reads the colour roles from the sibling checkout's palettes (never a hand-kept copy) and rewrites the
theme file with Ocean for light and dark, every flattened alpha token and `font-sans`.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_theme  # noqa: E402


def main(argv):
    palettes, out = Path(argv[1]), Path(argv[2])
    sources = build_theme.Sources(palettes=palettes)
    theme, _meta = build_theme.build_theme(build_theme.normalize_request({}), sources)
    build_theme.write_json(out, theme)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
