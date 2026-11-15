#!/usr/bin/env python3
"""Generate the sidebar stage art SVGs (SidebarStageBackdrop.tsx's nightly sky / dev blueprint, light
and dark) for a picked theme pair.

The reference colours the art per theme through `--stage-art-*` / `--stage-night-*` custom properties
in index.css, resolved per `html[data-theme-id="<id>"]` with a nested `@variant dark` override, plus
two generic aliasing rules every built-in theme shares (celeste/violet/grid-line mirror the theme's
own highlight/secondary/line; the night glow and sparkle mirror the resolved night highlight/secondary/
line) and, for t3-chat, ocean and iris, a `color-mix(in oklch, ...)` formula that derives the whole
night palette from the theme's own art palette instead of a value of its own (grove and ember set their
night palette directly). This module reads those rules straight out of index.css (never a hand-kept
copy) and mixes in OKLCH, the same space `color-mix(in oklch, ...)` uses — the mix is not the same as
`build_theme.py`'s `_mix_oklab` (an OKLAB mix for a different CSS rule).

Only the five built-in themes with `sidebarArtwork: true` in themePalettes.ts ever show this art: a
custom theme's `themeAllowsSidebarArtwork` is always false in the reference, so it is never asked to
colour the art and this module knows no custom palette. `generate_for` returns `None` for any id it
does not know (a custom theme, or an unknown one); the caller then leaves the stage directory's
checked-in Ocean SVG as it is, which is exactly what the reference does (no stage colour to apply).

    python3 tools/build_stage_art.py --light ocean --dark ember --out /tmp/stage

A window with the live-theme host repaints without a rebuild, so the launcher's per-build files above
cannot follow it. `--all` writes every theme's art (the five built-ins and "default", the standard
T3 Code theme painted from `:root`'s own values) into `<out>/themes/<id>-<art>-<mode>.svg`; those are
checked in and SidebarStageBackdrop.tsx picks one by the theme that is showing.

    python3 tools/build_stage_art.py --all --out t3ui/components/sidebar/stage
"""
from __future__ import annotations

import argparse
import math
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools import build_theme as bt  # noqa: E402  (after sys.path setup)

INDEX_CSS = bt.INDEX_CSS
BUILT_IN_IDS = bt.BUILT_IN_IDS

# Every theme id the reference paints the art for: its five built-in palettes plus "default", the
# standard T3 Code theme, whose colours are the `:root` defaults the built-ins override.
STANDARD_THEME_ID = bt.STANDARD_THEME_ID
ART_THEME_IDS = (STANDARD_THEME_ID, *BUILT_IN_IDS)
VARIANT_DIR = "themes"

ART_KEYS = ("top", "mid", "bottom", "highlight", "secondary", "tertiary", "line")
NIGHT_DIRECT_KEYS = ART_KEYS
WHITE = (1.0, 0.0, 0.0)  # oklch(1 0 0): the mix target stage-night-line uses.

OKLCH_RE = re.compile(r"oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)")
SVG_NAMES = ("nightly-dark.svg", "nightly-light.svg", "blueprint-dark.svg", "blueprint-light.svg")


class StageArtError(bt.ThemeError):
    """A theme or source this generator cannot turn into stage art."""


# --- reading the tokens out of index.css --------------------------------------------------------

def _parse_oklch(text: str) -> tuple:
    match = OKLCH_RE.fullmatch(text.strip())
    if not match:
        raise StageArtError(f"Unsupported stage colour: {text}")
    return tuple(float(part) for part in match.groups())


def _prop(body: str, name: str):
    match = re.search(rf"{re.escape(name)}:\s*(oklch\([^)]*\))", body)
    return _parse_oklch(match.group(1)) if match else None


def _theme_block(css_text: str, theme_id: str) -> str:
    needle = f'html[data-theme-id="{theme_id}"]'
    return bt._section(css_text, needle)


def night_base(css_text: str) -> dict:
    """The constant `--stage-night-base-*` the base `:root` paints (no per-theme or dark override)."""
    out = {}
    for key in ("top", "mid", "bottom"):
        value = _prop(css_text, f"--stage-night-base-{key}")
        if value is None:
            raise StageArtError(f"index.css is missing --stage-night-base-{key}")
        out[key] = value
    return out


def oklch_hex(color: tuple) -> str:
    lightness, chroma, hue = color
    a = chroma * math.cos(math.radians(hue))
    b = chroma * math.sin(math.radians(hue))
    r, g, bl = bt.oklab_to_rgb(lightness, a, b)
    return f"#{r:02x}{g:02x}{bl:02x}"


def mix_oklch(first: tuple, pct: float, second: tuple) -> tuple:
    """`color-mix(in oklch, first pct%, second)`: L and C interpolate linearly, H the short way round."""
    l1, c1, h1 = first
    l2, c2, h2 = second
    t = (100.0 - pct) / 100.0
    delta = ((h2 - h1 + 180.0) % 360.0) - 180.0
    return (l1 + (l2 - l1) * t, c1 + (c2 - c1) * t, (h1 + delta * t) % 360.0)


# --- resolving one theme's stage colours ----------------------------------------------------------

def resolve_theme(css_text: str, theme_id: str, mode: str) -> dict:
    """The stage colours (as oklch tuples) `theme_id` paints for `mode` ("light" or "dark"), or None
    for a theme this module does not colour the art for (any id outside the five built-ins)."""
    if theme_id == STANDARD_THEME_ID:
        return _resolve_standard(css_text, mode)
    if theme_id not in BUILT_IN_IDS:
        return None
    body = _theme_block(css_text, theme_id)
    art = {key: _prop(body, f"--stage-art-{key}") for key in ART_KEYS}
    night_direct = {key: _prop(body, f"--stage-night-{key}") for key in NIGHT_DIRECT_KEYS}
    if mode == "dark":
        dark_body = bt._section(body, "@variant dark")
        for key in ART_KEYS:
            value = _prop(dark_body, f"--stage-art-{key}")
            if value is not None:
                art[key] = value
        for key in NIGHT_DIRECT_KEYS:
            value = _prop(dark_body, f"--stage-night-{key}")
            if value is not None:
                night_direct[key] = value
    missing_art = [key for key, value in art.items() if value is None]
    if missing_art:
        raise StageArtError(f"index.css is missing stage-art-{missing_art[0]} for {theme_id}")

    if any(value is not None for value in night_direct.values()):
        # grove and ember paint their own night palette directly.
        night = {key: (night_direct[key] if night_direct[key] is not None else art[key]) for key in NIGHT_DIRECT_KEYS}
    else:
        # t3-chat, ocean and iris derive it from their own art palette (the :is(...) color-mix rule).
        base = night_base(css_text)
        night = {}
        night["top"] = mix_oklch(art["top"], 38, base["top"])
        night["mid"] = mix_oklch(art["mid"], 38, base["mid"])
        night["bottom"] = mix_oklch(art["bottom"], 38, base["bottom"])
        night["highlight"] = art["highlight"]
        night["secondary"] = mix_oklch(art["secondary"], 55, night["mid"])
        night["tertiary"] = mix_oklch(art["tertiary"], 60, night["top"])
        night["line"] = mix_oklch(art["line"], 82, WHITE)

    # The generic aliasing rule every built-in theme shares.
    return {
        "art_top": art["top"], "art_mid": art["mid"], "art_bottom": art["bottom"],
        "art_highlight": art["highlight"], "art_secondary": art["secondary"],
        "art_tertiary": art["tertiary"], "art_line": art["line"],
        "art_celeste_highlight": art["highlight"], "art_celeste_secondary": art["secondary"],
        "art_violet_highlight": art["highlight"], "art_grid_line": art["line"],
        "night_top": night["top"], "night_mid": night["mid"], "night_bottom": night["bottom"],
        "night_highlight": night["highlight"], "night_secondary": night["secondary"],
        "night_tertiary": night["tertiary"], "night_line": night["line"],
        "night_glow_highlight": night["highlight"], "night_glow_secondary": night["secondary"],
        "night_sparkle": night["line"],
    }


def _root_block(css_text: str) -> str:
    """The `:root` rule that declares the stage defaults (the one holding `--stage-art-top`)."""
    at = css_text.index("--stage-art-top:")
    return bt._section(css_text[css_text.rindex(":root", 0, at):], ":root")


def _resolve_standard(css_text: str, mode: str) -> dict:
    """The standard T3 Code theme ("default"): `:root`'s own values, none of the built-ins' aliasing
    (celeste, violet, grid line, glow and sparkle each have a colour of their own here), the night
    sky on the constant night base, and a dark override for the three paper stops only."""
    body = _root_block(css_text)
    names = {
        "art_top": "--stage-art-top", "art_mid": "--stage-art-mid", "art_bottom": "--stage-art-bottom",
        "art_highlight": "--stage-art-highlight", "art_secondary": "--stage-art-secondary",
        "art_tertiary": "--stage-art-tertiary", "art_line": "--stage-art-line",
        "art_celeste_highlight": "--stage-art-celeste-highlight",
        "art_celeste_secondary": "--stage-art-celeste-secondary",
        "art_violet_highlight": "--stage-art-violet-highlight", "art_grid_line": "--stage-art-grid-line",
        "night_top": "--stage-night-base-top", "night_mid": "--stage-night-base-mid",
        "night_bottom": "--stage-night-base-bottom", "night_highlight": "--stage-night-highlight",
        "night_secondary": "--stage-night-secondary", "night_tertiary": "--stage-night-tertiary",
        "night_line": "--stage-night-line", "night_glow_highlight": "--stage-night-glow-highlight",
        "night_glow_secondary": "--stage-night-glow-secondary", "night_sparkle": "--stage-night-sparkle",
    }
    out = {key: _prop(body, name) for key, name in names.items()}
    if mode == "dark":
        dark_body = bt._section(body, "@variant dark")
        for key, name in names.items():
            value = _prop(dark_body, name)
            if value is not None:
                out[key] = value
    missing = [key for key, value in out.items() if value is None]
    if missing:
        raise StageArtError(f"index.css is missing {names[missing[0]]} in :root")
    return out


def resolve_theme_hex(css_text: str, theme_id: str, mode: str):
    resolved = resolve_theme(css_text, theme_id, mode)
    return None if resolved is None else {key: oklch_hex(value) for key, value in resolved.items()}


# --- rendering the SVGs --------------------------------------------------------------------------
# The markup is the reference's (NightlySkyArt / DevBlueprintArt in SidebarStageBackdrop.tsx): a real
# feGaussianBlur on the clouds, the star and sparkle pattern, and a real alpha mask for the bottom
# fade, which the port's `<Image src=".svg">` path (resvg) draws in full, unlike NSH's inline <svg>
# canvas path. The reference combines the mask with a second gradient into the sidebar background.
# Because this art is drawn over that same background, their combined alpha is the mask multiplied
# by the inverse of that gradient. Sampling at 1% keeps the product of the linear segments accurate.
# Never write "--" inside an SVG comment: it breaks `nsh build`.

_SIDEBAR_FADE = ((0.0, 0.0), (0.28, 0.0), (0.40, 0.10), (0.52, 0.30),
                 (0.64, 0.58), (0.75, 0.82), (0.85, 0.96), (0.93, 1.0), (1.0, 1.0))


def stage_fade_alpha(position: float) -> float:
    """Reference sidebar-stage-backdrop mask and its background-colour gradient combined."""
    position = min(1.0, max(0.0, position))
    mask = 1.0 if position <= 0.55 else max(0.0, (0.92 - position) / 0.37)
    overlay = 1.0
    for (start, first), (end, last) in zip(_SIDEBAR_FADE, _SIDEBAR_FADE[1:]):
        if position <= end:
            overlay = first + (last - first) * (position - start) / (end - start)
            break
    return mask * (1.0 - overlay)


_FADE_MASK = (
    '<linearGradient id="fade" x1="0" y1="0" x2="0" y2="96" gradientUnits="userSpaceOnUse">'
    + ''.join(f'<stop offset="{i / 100:.2f}" stop-color="#fff" stop-opacity="{stage_fade_alpha(i / 100):.6f}"/>'
              for i in range(101))
    + '</linearGradient><mask id="fadeMask" maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="96">'
    '<rect width="100%" height="96" fill="url(#fade)"/></mask>'
)

_STAR_CIRCLES = (
    '<circle cx="14" cy="10" r="0.6" fill-opacity="0.85"/><circle cx="38" cy="22" r="0.4" fill-opacity="0.55"/>'
    '<circle cx="58" cy="8" r="0.5" fill-opacity="0.7"/><circle cx="84" cy="16" r="0.4" fill-opacity="0.5"/>'
    '<circle cx="104" cy="7" r="0.6" fill-opacity="0.8"/><circle cx="126" cy="20" r="0.4" fill-opacity="0.55"/>'
    '<circle cx="148" cy="11" r="0.5" fill-opacity="0.7"/><circle cx="170" cy="24" r="0.4" fill-opacity="0.5"/>'
    '<circle cx="192" cy="9" r="0.6" fill-opacity="0.8"/><circle cx="214" cy="18" r="0.4" fill-opacity="0.55"/>'
    '<circle cx="236" cy="8" r="0.5" fill-opacity="0.7"/><circle cx="258" cy="20" r="0.45" fill-opacity="0.6"/>'
    '<circle cx="278" cy="11" r="0.55" fill-opacity="0.75"/><circle cx="26" cy="34" r="0.4" fill-opacity="0.45"/>'
    '<circle cx="118" cy="34" r="0.4" fill-opacity="0.45"/><circle cx="202" cy="32" r="0.4" fill-opacity="0.5"/>'
    '<circle cx="268" cy="34" r="0.4" fill-opacity="0.45"/>'
)

_SPARKLE_PATHS = (
    '<path d="M68.5 28H71.5"/><path d="M70 26.5V29.5"/><path d="M158.5 36H161.5"/>'
    '<path d="M160 34.5V37.5"/><path d="M244.5 26H247.5"/><path d="M246 24.5V27.5"/>'
)

_NOTES_PATTERN_BODY = (
    '<g stroke="{line}" stroke-linecap="round" stroke-opacity="0.6" stroke-width="0.7">'
    '<path d="M180 64H264" stroke-dasharray="5 4"/><path d="M180 61V67M264 61V67"/>'
    '<path d="M276 10V44" stroke-dasharray="4 4" stroke-opacity="0.5"/><path d="M273 10H279M273 44H279" stroke-opacity="0.5"/>'
    '<path d="M348 30H428" stroke-dasharray="3.5 5" stroke-opacity="0.5"/><path d="M348 27V33M428 27V33" stroke-opacity="0.5"/>'
    '<path d="M512 48V80" stroke-dasharray="5 3" stroke-opacity="0.45"/><path d="M509 48H515M509 80H515" stroke-opacity="0.45"/>'
    '<path d="M590 70H724" stroke-dasharray="7 4" stroke-opacity="0.55"/><path d="M590 67V73M724 67V73" stroke-opacity="0.55"/>'
    '</g>'
    '<g stroke="{line}" stroke-linecap="round" stroke-opacity="0.55" stroke-width="0.6">'
    '<path d="M34 60L38 64M38 60L34 64"/><path d="M228 26H234M231 23V29"/><path d="M143 51H149M146 48V54"/>'
    '<path d="M316 16L322 22M322 16L316 22"/><path d="M468 70H476M472 66V74"/><path d="M558 28L564 34M564 28L558 34"/>'
    '<path d="M742 44H750M746 40V48"/>'
    '</g>'
    '<g stroke="{line}" stroke-opacity="0.35" stroke-width="0.6">'
    '<circle cx="196" cy="38" r="13" stroke-dasharray="3.5 4"/><path d="M196 33V43M191 38H201" stroke-opacity="0.6" stroke-width="0.4"/>'
    '<circle cx="414" cy="64" r="10" stroke-dasharray="2.5 3.5"/><path d="M414 60V68M410 64H418" stroke-opacity="0.6" stroke-width="0.4"/>'
    '<circle cx="648" cy="32" r="15" stroke-dasharray="4 5"/><path d="M648 26V38M642 32H654" stroke-opacity="0.6" stroke-width="0.4"/>'
    '</g>'
)


def render_nightly(colors: dict, theme_id: str, mode: str) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="8192" height="96" viewBox="0 0 8192 96" '
        'preserveAspectRatio="xMinYMin slice" fill="none">\n'
        f'<!-- SidebarStageBackdrop.tsx NightlySkyArt, {theme_id} {mode} palette, generated from index.css '
        f'by tools/build_stage_art.py. -->\n'
        '<defs>\n'
        f'<linearGradient id="sky" x1="24" y1="0" x2="264" y2="96" gradientUnits="userSpaceOnUse" spreadMethod="reflect">'
        f'<stop stop-color="{colors["night_bottom"]}"/><stop offset="0.5" stop-color="{colors["night_mid"]}"/>'
        f'<stop offset="1" stop-color="{colors["night_top"]}"/></linearGradient>\n'
        f'<radialGradient id="glow" cx="0" cy="0" r="1" gradientTransform="translate(216 18) rotate(137) scale(120 84)" '
        f'gradientUnits="userSpaceOnUse"><stop stop-color="{colors["night_glow_highlight"]}" stop-opacity="0.4"/>'
        f'<stop offset="0.5" stop-color="{colors["night_glow_secondary"]}" stop-opacity="0.16"/>'
        f'<stop offset="1" stop-color="{colors["night_bottom"]}" stop-opacity="0"/></radialGradient>\n'
        f'<linearGradient id="cloud" x1="0" y1="60" x2="288" y2="96" gradientUnits="userSpaceOnUse">'
        f'<stop stop-color="{colors["night_highlight"]}" stop-opacity="0.5"/>'
        f'<stop offset="0.52" stop-color="{colors["night_secondary"]}" stop-opacity="0.62"/>'
        f'<stop offset="1" stop-color="{colors["night_tertiary"]}" stop-opacity="0.5"/></linearGradient>\n'
        '<filter id="soft" x="-24" y="-24" width="336" height="144" filterUnits="userSpaceOnUse">'
        '<feGaussianBlur stdDeviation="4"/></filter>\n'
        f'<pattern id="stars" width="288" height="96" patternUnits="userSpaceOnUse"><g fill="{colors["night_line"]}">'
        f'{_STAR_CIRCLES}</g><g stroke="{colors["night_sparkle"]}" stroke-linecap="round" stroke-opacity="0.7" '
        f'stroke-width="0.6">{_SPARKLE_PATHS}</g></pattern>\n'
        '<pattern id="glows" width="640" height="96" patternUnits="userSpaceOnUse">'
        '<rect width="640" height="96" fill="url(#glow)"/></pattern>\n'
        f'{_FADE_MASK}\n'
        '</defs>\n'
        '<g mask="url(#fadeMask)">\n'
        '<rect width="100%" height="96" fill="url(#sky)"/>\n'
        '<rect width="100%" height="96" fill="url(#glows)"/>\n'
        '<rect width="100%" height="96" fill="url(#stars)"/>\n'
        '<g filter="url(#soft)">\n'
        '<path d="M-12 88C-12 74 0 63 14 63C18 50 30 41 44 41C58 41 70 49 74 62C79 57 86 54 94 54C110 54 123 66 124 82'
        'C132 83 138 88 141 96H-12V88Z" fill="url(#cloud)"/>\n'
        '</g>\n'
        '<g filter="url(#soft)">\n'
        '<path d="M150 96C151 84 161 75 173 75C176 64 186 57 198 57C210 57 220 64 223 75C231 75 238 80 241 87'
        'C250 87 257 91 260 96H150Z" fill="url(#cloud)" fill-opacity="0.8"/>\n'
        '</g>\n'
        '</g>\n'
        '</svg>\n'
    )


def render_blueprint(colors: dict, theme_id: str, mode: str) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="8192" height="96" viewBox="0 0 8192 96" '
        'preserveAspectRatio="xMinYMin slice" fill="none">\n'
        f'<!-- SidebarStageBackdrop.tsx DevBlueprintArt, {theme_id} {mode} palette, generated from index.css '
        f'by tools/build_stage_art.py. -->\n'
        '<defs>\n'
        f'<linearGradient id="paper" x1="60" y1="0" x2="220" y2="96" gradientUnits="userSpaceOnUse" spreadMethod="reflect">'
        f'<stop stop-color="{colors["art_top"]}"/><stop offset="0.5" stop-color="{colors["art_mid"]}"/>'
        f'<stop offset="1" stop-color="{colors["art_bottom"]}"/></linearGradient>\n'
        f'<radialGradient id="glow" cx="0" cy="0" r="1" gradientTransform="translate(216 14) rotate(137) scale(120 84)" '
        f'gradientUnits="userSpaceOnUse"><stop stop-color="{colors["art_highlight"]}" stop-opacity="0.4"/>'
        f'<stop offset="0.52" stop-color="{colors["art_secondary"]}" stop-opacity="0.16"/>'
        f'<stop offset="1" stop-color="{colors["art_bottom"]}" stop-opacity="0"/></radialGradient>\n'
        f'<radialGradient id="celeste" cx="0" cy="0" r="1" gradientTransform="translate(474 44) rotate(166) scale(156 92)" '
        f'gradientUnits="userSpaceOnUse"><stop stop-color="{colors["art_celeste_highlight"]}" stop-opacity="0.34"/>'
        f'<stop offset="0.5" stop-color="{colors["art_celeste_secondary"]}" stop-opacity="0.18"/>'
        f'<stop offset="1" stop-color="{colors["art_bottom"]}" stop-opacity="0"/></radialGradient>\n'
        f'<radialGradient id="violet" cx="0" cy="0" r="1" gradientTransform="translate(704 18) rotate(145) scale(132 88)" '
        f'gradientUnits="userSpaceOnUse"><stop stop-color="{colors["art_violet_highlight"]}" stop-opacity="0.3"/>'
        f'<stop offset="0.52" stop-color="{colors["art_tertiary"]}" stop-opacity="0.14"/>'
        f'<stop offset="1" stop-color="{colors["art_bottom"]}" stop-opacity="0"/></radialGradient>\n'
        f'<pattern id="minor" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M8 0H0V8" '
        f'stroke="{colors["art_grid_line"]}" stroke-opacity="0.14" stroke-width="0.5"/></pattern>\n'
        f'<pattern id="major" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" '
        f'stroke="{colors["art_grid_line"]}" stroke-opacity="0.26" stroke-width="0.6"/></pattern>\n'
        f'<pattern id="ruler" width="32" height="6" patternUnits="userSpaceOnUse">'
        f'<path d="M4 0V2.5M12 0V2.5M20 0V4M28 0V2.5" stroke="{colors["art_line"]}" stroke-opacity="0.5" '
        f'stroke-width="0.5"/></pattern>\n'
        '<pattern id="glows" width="768" height="96" patternUnits="userSpaceOnUse">'
        '<rect width="768" height="96" fill="url(#glow)"/><rect width="768" height="96" fill="url(#celeste)"/>'
        '<rect width="768" height="96" fill="url(#violet)"/></pattern>\n'
        f'<pattern id="notes" width="768" height="96" patternUnits="userSpaceOnUse">\n'
        f'{_NOTES_PATTERN_BODY.format(line=colors["art_line"])}'
        '</pattern>\n'
        f'{_FADE_MASK}\n'
        '</defs>\n'
        '<g mask="url(#fadeMask)">\n'
        '<rect width="100%" height="96" fill="url(#paper)"/>\n'
        '<rect width="100%" height="96" fill="url(#glows)"/>\n'
        '<rect width="100%" height="96" fill="url(#minor)"/>\n'
        '<rect width="100%" height="96" fill="url(#major)"/>\n'
        '<rect width="100%" height="6" fill="url(#ruler)"/>\n'
        '<rect width="100%" height="96" fill="url(#notes)"/>\n'
        '</g>\n'
        '</svg>\n'
    )


# --- the generator's public entry point ----------------------------------------------------------

def generate_for(css_text: str, light_theme_id: str, dark_theme_id: str) -> dict:
    """{filename: svg text} for the SVGs this generator can colour for the picked pair; a theme id
    outside the five built-ins contributes nothing (its mode's two files are left out)."""
    out = {}
    for mode, theme_id in (("light", light_theme_id), ("dark", dark_theme_id)):
        colors = resolve_theme_hex(css_text, theme_id, mode)
        if colors is None:
            continue
        out[f"nightly-{mode}.svg"] = render_nightly(colors, theme_id, mode)
        out[f"blueprint-{mode}.svg"] = render_blueprint(colors, theme_id, mode)
    return out


def generate_variants(css_text: str) -> dict:
    """{"themes/<id>-<art>-<mode>.svg": svg text} for every theme the reference paints the art for,
    both arts and both modes. These are checked in next to the default four, so the running app can
    swap the art the moment a theme is applied live (`theme.setOverrides`), with no rebuild: the
    reference's inline SVG follows its theme's custom properties the same way."""
    out = {}
    for theme_id in ART_THEME_IDS:
        for mode in ("light", "dark"):
            colors = resolve_theme_hex(css_text, theme_id, mode)
            out[f"{VARIANT_DIR}/{theme_id}-nightly-{mode}.svg"] = render_nightly(colors, theme_id, mode)
            out[f"{VARIANT_DIR}/{theme_id}-blueprint-{mode}.svg"] = render_blueprint(colors, theme_id, mode)
    return out


def generate_button_variants(css_text: str) -> dict:
    """T3's compact stage art: a square slice of the full art without the sidebar fade."""
    out = {}
    for name, svg in generate_variants(css_text).items():
        offset = 96 if "-nightly-" in name else 64
        compact = svg.replace('width="8192" height="96" viewBox="0 0 8192 96"',
                              f'width="96" height="96" viewBox="{offset} 0 96 96"', 1)
        compact = compact.replace('<g mask="url(#fadeMask)">', '<g>', 1)
        compact = compact.replace('width="100%" height="96"', 'width="8192" height="96"')
        compact = compact.replace('width="100%" height="6"', 'width="8192" height="6"')
        out[name.replace("themes/", "button-themes/")] = compact
    return out


def write_variants(stage_dir: Path, css_text: str) -> list:
    """Writes every theme's art into `stage_dir`/themes. Returns the relative names written."""
    variants = generate_variants(css_text)
    (stage_dir / VARIANT_DIR).mkdir(parents=True, exist_ok=True)
    for name, content in variants.items():
        (stage_dir / name).write_text(content)
    (stage_dir / "button-themes").mkdir(parents=True, exist_ok=True)
    for name, content in generate_button_variants(css_text).items():
        (stage_dir / name).write_text(content)
    return sorted(variants)


def write_stage_art(stage_dir: Path, light_theme_id: str, dark_theme_id: str, css_text: str) -> list:
    """Writes the themed SVGs this generator can colour into `stage_dir` (the sidebar stage art
    folder). Returns the filenames written; any other file already there (the checked-in Ocean
    default, or a theme this module does not colour) is left untouched."""
    svgs = generate_for(css_text, light_theme_id, dark_theme_id)
    stage_dir.mkdir(parents=True, exist_ok=True)
    for name, content in svgs.items():
        (stage_dir / name).write_text(content)
    return sorted(svgs)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--light", default=bt.DEFAULT_THEME_ID)
    parser.add_argument("--dark", default=bt.DEFAULT_THEME_ID)
    parser.add_argument("--out", required=True, help="the sidebar stage art folder to write into")
    parser.add_argument("--all", action="store_true",
                        help="write every theme's art into <out>/themes (the checked-in live-switch set)")
    args = parser.parse_args(argv)
    css_text = INDEX_CSS.read_text()
    if args.all:
        written = write_variants(Path(args.out), css_text)
        print(f"wrote {len(written)} files into {args.out}/{VARIANT_DIR}")
        return 0
    written = write_stage_art(Path(args.out), args.light, args.dark, css_text)
    if written:
        print(f"wrote {args.out}: {', '.join(written)}")
    else:
        print(f"{args.light}/{args.dark}: no built-in theme colours this art; nothing written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
