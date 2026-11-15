#!/usr/bin/env python3
"""Build the NSH app theme (theme.json) for any T3 theme pair and contrast.

NSH fixes the palette when the UI bundle is built, so the app picks a theme by asking the launcher
(tools/run_local.py) for a re-themed rebuild. This is the engine behind that request, and the one
generator behind t3ui/theme.json:

  * `default` is the T3 Code theme as index.css paints it (tools/gen_nsh_theme.py).
  * a built-in id (t3-chat, grove, ocean, ember, iris) comes from packages/shared/src/themePalettes.ts.
  * a custom id comes from the request (the shape of t3ui/pages/settings/customThemes.ts: id, label,
    appearance and hex colours keyed by the web's theme roles) laid over the standard T3 palette.
  * light and dark each carry their own theme id, as the reference lets the user pick one for each.
  * contrast is the reference's `appearanceContrast` (50..200, default 100), applied the way
    apps/web/src/appearanceContrast.ts and the `--contrast-*` rules of index.css apply it.

Every flattened alpha token (see PORT.md, "Alpha modifiers are squared by NSH") and `font-sans` are
emitted for every theme. Python 3.9 compatible.

  python3 tools/build_theme.py --light ocean --dark ocean --contrast 100 --out t3ui/theme.json
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import threading
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

CHECKOUT = Path(__file__).resolve().parent.parent.parent / "t3code"
PALETTES_TS = Path(os.environ.get("T3_THEME_PALETTES") or CHECKOUT / "packages" / "shared" / "src" / "themePalettes.ts")
INDEX_CSS = Path(os.environ.get("T3_INDEX_CSS") or CHECKOUT / "apps" / "web" / "src" / "index.css")

DEFAULT_THEME_ID = "ocean"
STANDARD_THEME_ID = "default"
MIN_CONTRAST, MAX_CONTRAST, DEFAULT_CONTRAST = 50, 200, 100
BUILT_IN_IDS = ("t3-chat", "grove", "ocean", "ember", "iris")
RESERVED_IDS = {"system", "light", "dark", "default", "t3-code", *BUILT_IN_IDS}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
HEX_RE = re.compile(r"^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$", re.I)


class ThemeError(ValueError):
    """A request or source the generator cannot turn into a theme."""


# --- colours -----------------------------------------------------------------------------------

def _encode(channel: float) -> int:
    channel = max(0.0, min(1.0, channel))
    return round(255 * (12.92 * channel if channel <= 0.0031308 else 1.055 * channel ** (1 / 2.4) - 0.055))


def _decode(value: float) -> float:
    value /= 255.0
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def oklab_to_rgb(lightness: float, a: float, b: float) -> tuple:
    l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3
    return (_encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
            _encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
            _encode(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s))


def rgb_to_oklab(r: float, g: float, b: float) -> tuple:
    lr, lg, lb = _decode(r), _decode(g), _decode(b)
    l = (0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb) ** (1 / 3)
    m = (0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb) ** (1 / 3)
    s = (0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb) ** (1 / 3)
    return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)


def parse_color(value: str) -> tuple:
    """(r, g, b, a) of an oklch(), #hex or rgb()/rgba() colour; r, g, b in 0..255."""
    text = value.strip()
    m = re.fullmatch(r"oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*/\s*([\d.]+%?))?\s*\)", text)
    if m:
        lightness, chroma, hue = (float(m.group(i)) for i in (1, 2, 3))
        alpha = 1.0
        if m.group(4):
            alpha = float(m.group(4)[:-1]) / 100 if m.group(4).endswith("%") else float(m.group(4))
        r, g, b = oklab_to_rgb(lightness, chroma * math.cos(math.radians(hue)), chroma * math.sin(math.radians(hue)))
        return (float(r), float(g), float(b), alpha)
    m = re.fullmatch(r"#([0-9a-fA-F]{3,8})", text)
    if m and len(m.group(1)) in (3, 4, 6, 8):
        h = m.group(1)
        if len(h) in (3, 4):
            h = "".join(c * 2 for c in h)
        alpha = int(h[6:8], 16) / 255.0 if len(h) == 8 else 1.0
        return (float(int(h[0:2], 16)), float(int(h[2:4], 16)), float(int(h[4:6], 16)), alpha)
    m = re.fullmatch(r"rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)", text)
    if m:
        alpha = 1.0
        if m.group(4):
            alpha = float(m.group(4)[:-1]) / 100 if m.group(4).endswith("%") else float(m.group(4))
        return (float(m.group(1)), float(m.group(2)), float(m.group(3)), alpha)
    raise ThemeError(f"Unsupported colour: {value}")


def fmt(color: tuple) -> str:
    r, g, b, a = color
    r, g, b = (max(0, min(255, round(c))) for c in (r, g, b))
    return f"rgb({r},{g},{b})" if a >= 0.9995 else f"rgba({r},{g},{b},{round(a, 4):g})"


def _mix_oklab(first: tuple, p: float, second: tuple) -> tuple:
    """color-mix(in oklab, first p, second): premultiplied, p in 0..1."""
    parts = []
    for color, weight in ((first, p), (second, 1.0 - p)):
        lab = rgb_to_oklab(color[0], color[1], color[2])
        parts.append((lab, color[3], weight))
    alpha = sum(a * w for _, a, w in parts)
    if alpha <= 0:
        return (0.0, 0.0, 0.0, 0.0)
    lab = tuple(sum(c[i] * a * w for c, a, w in parts) / alpha for i in range(3))
    r, g, b = oklab_to_rgb(*lab)
    return (float(r), float(g), float(b), alpha)


def _mix_srgb(first: tuple, p: float, second: tuple) -> tuple:
    """color-mix(in srgb, first p, second): premultiplied, p in 0..1."""
    wa, wb = first[3] * p, second[3] * (1.0 - p)
    alpha = wa + wb
    if alpha <= 0:
        return (0.0, 0.0, 0.0, 0.0)
    return tuple((first[i] * wa + second[i] * wb) / alpha for i in range(3)) + (alpha,)


# --- contrast (index.css `--contrast-*`, appearanceContrast.ts) --------------------------------

# Foreground tokens: oklab mix with the surface they sit on, then toward the target (black/white).
CONTRAST_FOREGROUNDS = {
    "toolbar-foreground": "toolbar-background",
    "toolbar-control-foreground": "toolbar-control",
    "foreground": "background",
    "muted-foreground": "background",
    "placeholder": "background",
    "secondary-label": "background",
    "icon-muted": "background",
    "card-foreground": "card",
    "popover-foreground": "popover",
    "accent-foreground": "accent",
    "secondary-foreground": "secondary",
    "message-foreground": "message-surface",
    "sidebar-foreground": "sidebar",
    "sidebar-muted-foreground": "sidebar",
}
# Line tokens: fade to transparent, then toward the foreground they sit beside.
CONTRAST_BORDERS = {
    "toolbar-border": "toolbar-foreground",
    "input": "foreground",
    "border": "foreground",
    "sidebar-border": "sidebar-foreground",
}


def apply_contrast(tokens: dict, contrast: int, appearance: str) -> dict:
    """The block with the reference's contrast applied: base = min(c, 100)%, boost = max(c - 100, 0)%,
    border boost = boost / 4, boost target black (light) or white (dark). Identity at 100."""
    if contrast == DEFAULT_CONTRAST:
        return dict(tokens)
    base = min(contrast, 100) / 100.0
    boost = max(contrast - 100, 0) / 100.0
    border_boost = boost / 4.0
    target = (255.0, 255.0, 255.0, 1.0) if appearance == "dark" else (0.0, 0.0, 0.0, 1.0)
    colors = {name: parse_color(value) for name, value in tokens.items() if _is_color(value)}
    out = dict(tokens)
    for name, surface in CONTRAST_FOREGROUNDS.items():
        if name not in colors or surface not in colors:
            continue
        inner = _mix_oklab(colors[name], base, colors[surface])
        out[name] = fmt(_mix_oklab(inner, 1.0 - boost, target))
    for name, line in CONTRAST_BORDERS.items():
        if name not in colors or line not in colors:
            continue
        inner = (colors[name][0], colors[name][1], colors[name][2], colors[name][3] * base)
        out[name] = fmt(_mix_srgb(inner, 1.0 - border_boost, colors[line]))
    return out


def _is_color(value) -> bool:
    return isinstance(value, str) and bool(re.match(r"^(rgba?\(|#)", value.strip()))


# --- sources -----------------------------------------------------------------------------------

def _section(text: str, marker: str) -> str:
    start = text.index("{", text.index(marker))
    depth = 0
    for pos in range(start, len(text)):
        depth += (text[pos] == "{") - (text[pos] == "}")
        if depth == 0:
            return text[start + 1:pos]
    raise ThemeError(f"Unclosed theme section {marker}")


def _roles(text: str) -> dict:
    return {name: value for name, value in re.findall(r'(\w+):\s*"([^"]+)"', text)}


def parse_palettes(source: str) -> dict:
    """{id: {label, appearance, colors, variants}} for the built-in themes, plus the standard T3 palette
    under "standard-light" and "standard-dark" (index.css paints the dark canvas #000000)."""
    out = {}
    for const in re.findall(r"export const (\w+_THEME): ThemeDefinition", source):
        body = _section(source, f"export const {const}:")
        theme_id = re.search(r'\bid:\s*"([^"]+)"', body).group(1)
        label = re.search(r'\blabel:\s*"([^"]+)"', body).group(1)
        appearance = re.search(r'\bappearance:\s*"(light|dark)"', body).group(1)
        colors = _roles(_section(body, "colors:"))
        variants = {}
        if "variants:" in body:
            variants_body = _section(body, "variants:")
            for mode in ("light", "dark"):
                if re.search(rf"\b{mode}:\s*\{{", variants_body):
                    variants[mode] = _roles(_section(variants_body, f"{mode}:"))
        out[theme_id] = {"label": label, "appearance": appearance, "colors": colors, "variants": variants}
    light = _roles(_section(source, "export const T3_CODE_LIGHT_THEME_COLORS:"))
    dark = _roles(_section(source, "export const T3_CODE_DARK_THEME_COLORS:"))
    dark["canvas"] = "#000000"
    out["standard-light"] = {"label": "R3 Code", "appearance": "light", "colors": light, "variants": {}}
    out["standard-dark"] = {"label": "R3 Code", "appearance": "dark", "colors": dark, "variants": {}}
    return out


class Sources:
    """The reference inputs, read once: index.css tokens and the built-in palettes."""

    def __init__(self, css: Path = INDEX_CSS, palettes: Path = PALETTES_TS):
        try:
            css_text = Path(css).read_text()
            palettes_text = Path(palettes).read_text()
        except OSError as exc:
            raise ThemeError(f"Cannot read the reference theme sources: {exc}") from exc
        import contextlib
        import io
        saved = sys.argv
        sys.argv = [saved[0], str(css)]
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                import gen_nsh_theme as gen
        finally:
            sys.argv = saved
        self.gen = gen
        self.css_text = css_text
        light_defs, dark_defs = gen.base_blocks(css_text)
        self.radius = gen.radius_token(css_text)
        self.base = {"light": gen.block(light_defs), "dark": gen.block(dark_defs)}
        self.palettes = parse_palettes(palettes_text)


# --- the roles of a theme, as theme tokens -----------------------------------------------------

ROLES = {
    "background": "canvas", "app-chrome-background": "chrome", "toolbar-background": "toolbar",
    "toolbar-foreground": "toolbarForeground", "toolbar-border": "toolbarBorder", "toolbar-control": "toolbarControl",
    "toolbar-control-foreground": "toolbarControlForeground", "toolbar-control-hover": "toolbarControlHover",
    "surface-raised": "surfaceRaised", "foreground": "text", "card": "surface", "card-foreground": "text",
    "popover": "surfaceOverlay", "popover-foreground": "text", "primary": "messageAction",
    "primary-foreground": "messageActionForeground", "secondary": "secondary", "secondary-foreground": "secondaryForeground",
    "muted": "muted", "muted-foreground": "mutedForeground", "placeholder": "placeholder",
    "secondary-label": "secondaryLabel", "icon-muted": "iconMuted", "accent": "accentSurface",
    "accent-foreground": "accentSurfaceForeground", "message-surface": "messageSurface", "message-foreground": "messageForeground",
    "message-action": "messageAction", "message-action-foreground": "messageActionForeground", "message-action-hover": "messageActionHover",
    "error": "error", "error-foreground": "errorForeground", "error-surface": "errorSurface", "tool-error-icon": "errorForeground",
    "destructive": "error", "destructive-foreground": "errorForeground", "warning": "warning", "warning-foreground": "warningForeground",
    "warning-surface": "warningSurface", "update": "update", "update-foreground": "updateForeground", "border": "border",
    "input": "input", "ring": "focus", "sidebar": "sidebar", "sidebar-foreground": "sidebarForeground",
    "sidebar-muted-foreground": "sidebarMutedForeground", "sidebar-control-surface": "sidebarControlSurface",
    "sidebar-row-hover": "sidebarRowHover", "sidebar-row-active": "sidebarRowActive", "sidebar-row-selected": "sidebarRowSelected",
    "sidebar-border": "sidebarBorder", "sidebar-stage-fade": "sidebar", "code-background": "codeBackground",
    "code-foreground": "codeForeground", "terminal-background": "terminalBackground", "terminal-foreground": "terminalForeground",
    "terminal-cursor": "terminalCursor", "terminal-selection-background": "terminalSelection",
}


def _color_ok(value) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parse_color(value)
    except ThemeError:
        return False
    return True


def _check_colors(colors, theme_id: str, what: str = "colours") -> dict:
    if not isinstance(colors, dict):
        raise ThemeError(f"The custom theme {theme_id} needs {what}")
    checked = {}
    for role, value in colors.items():
        # The app stores hex; any literal colour the generator can read (hex, rgb(), oklch()) is accepted.
        if not isinstance(role, str) or not _color_ok(value):
            raise ThemeError(f"The colour {role!r} of {theme_id} must be a colour value")
        checked[role] = value.strip()
    return checked


def validate_custom(theme) -> dict:
    """A custom theme as the app saves it: {id, label, appearance, colors{role: colour}} and, optionally,
    `variants` ({light|dark: colors} for the other appearance), `collection` ({id, label}) and `managed`."""
    if not isinstance(theme, dict):
        raise ThemeError("A custom theme must be an object")
    theme_id, label, appearance, colors = (theme.get(k) for k in ("id", "label", "appearance", "colors"))
    if not isinstance(theme_id, str) or not ID_RE.match(theme_id) or theme_id in RESERVED_IDS:
        raise ThemeError(f"Invalid custom theme id: {theme_id!r}")
    if not isinstance(label, str) or not label.strip():
        raise ThemeError(f"The custom theme {theme_id} needs a label")
    if appearance not in ("light", "dark"):
        raise ThemeError(f"The custom theme {theme_id} needs an appearance of light or dark")
    out = {"id": theme_id, "label": label.strip(), "appearance": appearance,
           "colors": _check_colors(colors, theme_id)}
    variants = theme.get("variants")
    if variants is not None:
        if not isinstance(variants, dict):
            raise ThemeError(f"The variants of {theme_id} must be an object")
        checked = {}
        for mode, variant_colors in variants.items():
            if mode not in ("light", "dark") or mode == appearance:
                raise ThemeError(f"The custom theme {theme_id} has an invalid variant {mode!r}")
            checked[mode] = _check_colors(variant_colors, theme_id, "variant colours")
        if checked:
            out["variants"] = checked
    collection = theme.get("collection")
    if collection is not None:
        if not isinstance(collection, dict) or not isinstance(collection.get("id"), str) \
                or not isinstance(collection.get("label"), str):
            raise ThemeError(f"The collection of {theme_id} needs an id and a label")
        out["collection"] = {"id": collection["id"], "label": collection["label"]}
    if theme.get("managed") is True:
        out["managed"] = True
    return out


def theme_roles(theme_id: str, mode: str, sources: Sources, customs: dict):
    """The role colours a theme paints for one mode, or None for the standard T3 Code theme."""
    if theme_id == STANDARD_THEME_ID:
        return None
    if theme_id in customs:
        custom = customs[theme_id]
        # getThemeColorsForMode: the mode's own palette (the base colours, or the variant of the other
        # appearance). A theme with no palette for this mode paints its only one.
        if mode != custom["appearance"] and mode in custom.get("variants", {}):
            palette_mode, overrides = mode, custom["variants"][mode]
        else:
            palette_mode, overrides = custom["appearance"], custom["colors"]
        # parseThemeFile: colours a theme file leaves out come from getDefaultThemeColors, which is T3 Chat.
        chat = sources.palettes["t3-chat"]
        base = chat["variants"].get(palette_mode) if palette_mode != chat["appearance"] else chat["colors"]
        roles = dict(base or chat["colors"])
        roles.update(overrides)
        return roles
    palette = sources.palettes.get(theme_id)
    if palette is None or theme_id.startswith("standard-"):
        raise ThemeError(f"Unknown theme: {theme_id}")
    # getThemeColorsForMode: the mode's variant, else the theme's own colours.
    if mode == palette["appearance"]:
        return palette["colors"]
    return palette["variants"].get(mode) or palette["colors"]


def paint_roles(tokens: dict, roles: dict) -> None:
    canvas = parse_color(roles["canvas"])
    for token, role in ROLES.items():
        if role not in roles:
            continue
        r, g, b, a = parse_color(roles[role])
        if a < 1.0:
            # A translucent role is shown over the canvas, as the opaque tokens NSH needs.
            r, g, b = (c * a + k * (1 - a) for c, k in zip((r, g, b), canvas[:3]))
        tokens[token] = fmt((r, g, b, 1.0))


# --- flattened alpha tokens --------------------------------------------------------------------

# (token, alpha, surface it sits on): the alpha classes the app uses, composited into opaque tokens named
# `<token>-<alpha>` (`<token>` at 100). See PORT.md "Alpha modifiers are squared by NSH".
FLATTEN = [
    ("card", 40, "background"), ("border", 60, "card"), ("border", 50, "card"), ("accent", 50, "card"),
    ("border", 100, "card"), ("input", 100, "card"), ("input", 32, "card"),
    ("sidebar-row-selected", 100, "sidebar"), ("sidebar-row-hover", 100, "sidebar"), ("sidebar-row-active", 100, "sidebar"),
    ("muted", 100, "background"), ("muted", 10, "card"),
    # ProviderInstanceCard's list status line (text-muted-foreground/80)
    ("muted-foreground", 80, "card"),
    # KeybindingRowWhen's "When" label: text-muted-foreground/70 on the settings card
    ("muted-foreground", 70, "card"),
    ("accent", 100, "background"),
    # dropdown-glass: popover at its 84% glass fill over the page
    ("popover", 84, "background"),
    # composer model picker popover (ModelPickerContent)
    ("border", 70, "popover"), ("muted", 40, "popover"), ("muted", 30, "popover"),
    # DialogFooter (ui/dialog.tsx): bg-muted/72 on the dialog card, which is the page colour
    ("muted", 72, "background"),
    # ThemeLibrary preview well: bg-muted/50 on the settings card
    ("muted", 50, "card"),
    # SidebarDraftRow (draftSurfaceClassName): bg-warning/4, hover:bg-warning/8 on the sidebar as drawn: its surface-grain (3.5% mid-grey, Sidebar.tsx)
    ("warning", 4, "sidebar-grain"), ("warning", 8, "sidebar-grain"),
    # ThreadHeader linked-origin badge: bg-info/28 (light), dark:bg-info/40 on the page
    ("info", 28, "background"), ("info", 40, "background"),
    # Alert variant="info" (ui/alert.tsx): border-info/32 bg-info/4 on the dialog/page colour
    ("info", 32, "background"), ("info", 4, "background"),
    # DevicePanel's error Notice strip (ui/badge.tsx's error variant, bg-destructive/8) on the right panel's page colour
    ("destructive", 8, "background"),
]


def _over(front: tuple, back: tuple, alpha: float) -> tuple:
    return tuple(front[i] * alpha + back[i] * (1 - alpha) for i in range(3))


def _opaque(tokens: dict, name: str, over: tuple) -> tuple:
    color = parse_color(tokens[name])
    return _over(color, over, color[3])


def flatten_tokens(tokens: dict) -> dict:
    """Opaque stand-ins for every alpha-modified class the app uses, plus the thread details card and
    provider list surfaces, computed from the (contrast-adjusted) tokens of one mode."""
    out = {}
    colors = {name: parse_color(value) for name, value in tokens.items() if _is_color(value)}
    if "sidebar" in colors:
        # The sidebar is drawn with a 3.5% mid-grey grain over its token (Sidebar.tsx mixColors("#808080", sidebar, 0.035)).
        grain = tuple(128 * 0.035 + c * 0.965 for c in colors["sidebar"][:3])
        colors["sidebar-grain"] = grain + (colors["sidebar"][3],)
    for token, alpha, base in FLATTEN:
        if token not in colors or base not in colors:
            continue
        front, back = colors[token], colors[base]
        if front[3] == 0:
            continue  # a transparent token leaves the surface alone
        r, g, b = _over(front, back, front[3] * alpha / 100.0)
        out[token if alpha == 100 else f"{token}-{alpha}"] = f"rgb({round(r)},{round(g)},{round(b)})"

    def tint(front: str, back: tuple, opacity: float) -> tuple:
        return tuple(round(f * opacity + b * (1 - opacity)) for f, b in zip(front_rgb[front], back))

    need = ("background", "popover", "foreground", "border", "muted-foreground", "card", "muted", "input")
    if not all(name in colors for name in need):
        return out
    front_rgb = {name: colors[name][:3] for name in need}
    background = _opaque(tokens, "background", (0, 0, 0))
    # The thread details card (dropdown-glass over the page, threadDetailsPanelStyles.ts).
    card = tuple(round(f * 0.84 + b * 0.16) for f, b in zip(_opaque(tokens, "popover", background), background))
    dark = sum(background) < 384
    white, black = (255, 255, 255), (0, 0, 0)
    hover = tuple(round(f * 0.08 + b * 0.92) for f, b in zip(white, card)) if dark else \
        tuple(round(f * 0.035 + b * 0.965) for f, b in zip(black, card))
    out["details-row-hover"] = fmt(hover + (1.0,))
    out["details-card-border"] = fmt(tint("foreground", card, 0.10) + (1.0,))
    out["details-divider"] = fmt(tint("border", card, 0.65) + (1.0,))
    out["details-label"] = fmt(tint("foreground", card, 0.80) + (1.0,))
    out["details-title"] = fmt(tint("foreground", card, 0.85) + (1.0,))
    out["details-muted-70"] = fmt(tint("muted-foreground", card, 0.70) + (1.0,))
    out["details-dot-idle"] = fmt(tint("muted-foreground", card, 0.45) + (1.0,))
    # ProviderInstanceCard: foreground/6 for selection, muted/25 for hover, on the list's card surface.
    surface = _opaque(tokens, "card", background)
    out["provider-row-selected"] = fmt(tuple(round(f * 0.06 + b * 0.94) for f, b in zip(front_rgb["foreground"], surface)) + (1.0,))
    out["provider-row-hover"] = fmt(tuple(round(f * 0.25 + b * 0.75) for f, b in zip(colors["muted"][:3], surface)) + (1.0,))
    # CommandFooter (ui/command.tsx): bg-foreground/[0.025] with a border-t of foreground/[0.07], on the palette card (the page colour).
    footer = tint("foreground", background, 0.025)
    out["command-footer"] = fmt(footer + (1.0,))
    out["command-footer-border"] = fmt(tuple(round(f * 0.07 + b * 0.93) for f, b in zip(front_rgb["foreground"], footer)) + (1.0,))
    # Kbd (ui/kbd.tsx): bg-foreground/[0.07] on a settings row, which is the settings card (bg-card/40) over the page.
    row = tuple(f * 0.4 * colors["card"][3] + b * (1 - 0.4 * colors["card"][3]) for f, b in zip(colors["card"][:3], background))
    out["kbd-key"] = fmt(tuple(round(f * 0.07 + b * 0.93) for f, b in zip(front_rgb["foreground"], row)) + (1.0,))
    # The keybindings When builder (KeybindingsSettings.tsx) draws nested boxes with alpha fills over its popover, which is
    # `dropdown-glass`: the popover token at 84% over the page.
    popup = tuple(f * 0.84 * colors["popover"][3] + b * (1 - 0.84 * colors["popover"][3]) for f, b in zip(colors["popover"][:3], background))

    def on_popup(token: str, alpha: float) -> str:
        return fmt(tuple(round(f * alpha + b * (1 - alpha)) for f, b in zip(front_rgb[token], popup)) + (1.0,))

    out["when-group"] = on_popup("muted", 0.10)        # bg-muted/10
    out["when-group-nested"] = on_popup("background", 0.55)  # depth > 0: bg-background/55
    out["when-condition"] = on_popup("background", 0.60)     # bg-background/60
    out["when-not"] = on_popup("muted", 0.20)          # bg-muted/20
    out["when-empty"] = on_popup("muted", 0.15)        # bg-muted/15
    out["when-border"] = on_popup("border", 0.60)      # border-border/60
    out["when-border-nested"] = on_popup("border", 0.70)  # border-border/70
    out["when-empty-border"] = on_popup("border", 0.80)   # border-border/80
    # Segmented ToggleGroup (ui/toggle-group.tsx, ui/toggle.tsx): the track is bg-input/40 on the page; a pressed item is
    # bg-background (light) or bg-input/72 on the track (dark); hover is bg-background/55 (light) or bg-input/32 (dark).
    # The input token can itself be translucent (the default dark theme is white with alpha).
    # CSS's /40 and /72 multiply that alpha; discarding it makes both controls nearly white.
    input_alpha = colors["input"][3]
    track = _over(colors["input"], background, input_alpha * 0.4)
    out["segmented-track"] = fmt(tuple(round(c) for c in track) + (1.0,))
    mix = lambda front, back, alpha: tuple(round(f * alpha + b * (1 - alpha)) for f, b in zip(front, back))
    if dark:
        out["segmented-active"] = fmt(mix(front_rgb["input"], track, input_alpha * 0.72) + (1.0,))
        out["segmented-hover"] = fmt(mix(front_rgb["input"], track, input_alpha * 0.32) + (1.0,))
    else:
        out["segmented-active"] = fmt(tuple(round(c) for c in background) + (1.0,))
        out["segmented-hover"] = fmt(mix(front_rgb["background"], track, 0.55) + (1.0,))
    # Its keycaps: bg-foreground/[0.08] on that footer.
    out["command-footer-kbd"] = fmt(tuple(round(f * 0.08 + b * 0.92) for f, b in zip(front_rgb["foreground"], footer)) + (1.0,))
    return out


# --- the theme ---------------------------------------------------------------------------------

def normalize_request(raw) -> dict:
    """A request as the app writes it: {themeLight, themeDark, contrast, customThemes, requestId}."""
    if not isinstance(raw, dict):
        raise ThemeError("The theme request must be an object")
    out = {}
    for key, fallback in (("themeLight", DEFAULT_THEME_ID), ("themeDark", DEFAULT_THEME_ID)):
        value = raw.get(key, fallback)
        if not isinstance(value, str) or not ID_RE.match(value):
            raise ThemeError(f"Invalid {key}: {value!r}")
        out[key] = value
    contrast = raw.get("contrast", DEFAULT_CONTRAST)
    if isinstance(contrast, bool) or not isinstance(contrast, (int, float)) or contrast != int(contrast) \
            or not MIN_CONTRAST <= contrast <= MAX_CONTRAST:
        raise ThemeError(f"The contrast must be a whole number from {MIN_CONTRAST} to {MAX_CONTRAST}")
    out["contrast"] = int(contrast)
    customs = raw.get("customThemes", [])
    if not isinstance(customs, list):
        raise ThemeError("customThemes must be a list")
    out["customThemes"] = [validate_custom(item) for item in customs]
    request_id = raw.get("requestId", "")
    out["requestId"] = request_id if isinstance(request_id, str) else str(request_id)
    return out


def default_request() -> dict:
    return {"themeLight": DEFAULT_THEME_ID, "themeDark": DEFAULT_THEME_ID, "contrast": DEFAULT_CONTRAST,
            "customThemes": [], "requestId": ""}


def effective(request: dict) -> dict:
    """What a bundle built from the request shows: the two theme ids, the contrast and the custom
    themes those ids use. Two requests with the same value need no rebuild."""
    used = {request["themeLight"], request["themeDark"]}
    return {"light": request["themeLight"], "dark": request["themeDark"], "contrast": request["contrast"],
            "customs": sorted((t for t in request["customThemes"] if t["id"] in used), key=lambda t: t["id"],
                              )}


def build_theme(request: dict, sources: Sources) -> tuple:
    """(theme.json value, metadata) for a normalized request."""
    customs = {theme["id"]: theme for theme in request["customThemes"]}
    blocks = {}
    for mode, theme_id in (("light", request["themeLight"]), ("dark", request["themeDark"])):
        tokens = dict(sources.base[mode])
        roles = theme_roles(theme_id, mode, sources, customs)
        if roles is not None:
            paint_roles(tokens, roles)
        tokens = apply_contrast(tokens, request["contrast"], mode)
        tokens.update(flatten_tokens(tokens))
        blocks[mode] = dict(sorted(tokens.items()))
    theme = {
        "name": "R3 Code",
        "cssVars": {
            "theme": {"radius": sources.radius, "font-sans": sources.gen.INTERFACE_FONT_STACK},
            "light": blocks["light"],
            "dark": blocks["dark"],
        },
    }
    meta = {"light": request["themeLight"], "dark": request["themeDark"], "contrast": request["contrast"]}
    return theme, meta


# --- launcher support: stage a themed build, watch the app's request file ---------------------

REQUEST_FILE = "theme-request.json"
STATUS_FILE = "theme-status.json"
# Written whenever a choice is made, live apply or rebuild alike (themeRequest.ts): the persisted
# choice `LauncherThemes.start()` reads for the next launch's themed first build. Kept apart from
# REQUEST_FILE/STATUS_FILE so writing it never triggers the rebuild loop's `changed()` (a live apply
# must not also queue a rebuild): only REQUEST_FILE is watched for that.
LAST_FILE = "theme-last.json"
# The live path (LiveThemeWatcher below): the app writes LIVE_REQUEST_FILE instead of REQUEST_FILE
# when `nsh/host`'s `available()` is true (a host with the `theme.setOverrides` patch, "live-theme"
# README section); this generates the same theme.json shape into LIVE_RESULT_FILE and answers in
# LIVE_STATUS_FILE, polled at LiveThemeWatcher.POLL_SECONDS instead of the slow rebuild loop's
# ~0.5 s cadence, so a live apply is not held to it.
LIVE_REQUEST_FILE = "theme-live-request.json"
LIVE_RESULT_FILE = "theme-live.json"
LIVE_STATUS_FILE = "theme-live-status.json"
BUILT_ENV = "T3GPUI_BUILT_THEME"
MAX_REQUEST_BYTES = 1_000_000


def _copy_ignore(app_dir: Path):
    def ignore(directory, names):
        here = Path(directory)
        skip = [n for n in names if n.endswith((".test.ts", ".test.tsx"))]
        if here == app_dir:
            skip += [n for n in names if n.endswith(".png") or n in ("usage-probe", "theme.json", "nsh.json")]
        if here == app_dir / ".nsh":
            skip += [n for n in names if n in ("out", "test")]
        return skip
    return ignore


def stage_theme_build(app_entry: Path, stage_dir: Path, request: dict, sources: Sources) -> dict:
    """Write a themed copy of the app into `stage_dir` and return what it shows.

    `nsh build` fixes the palette from the `theme` of the nsh.json next to the entry and gathers the app's
    assets from that folder, so the build copy is the whole app folder (sources and assets, not tests or
    screenshots) with its own nsh.json, whose `theme` points at the generated theme.json and which also
    grants the env name the app reads its built theme from. The repo's t3ui/theme.json is never touched.
    The theme is generated in memory first, so a failure before the copy leaves `stage_dir` as it was.
    """
    import shutil
    app_entry = Path(app_entry).resolve()
    app_dir = app_entry.parent
    manifest = json.loads((app_dir / "nsh.json").read_text())
    theme, meta = build_theme(request, sources)
    manifest["theme"] = "theme.json"
    env = manifest.setdefault("capabilities", {}).setdefault("process", {}).setdefault("env", [])
    if BUILT_ENV not in env:
        env.append(BUILT_ENV)
    shutil.rmtree(stage_dir, ignore_errors=True)
    shutil.copytree(app_dir, stage_dir, ignore=_copy_ignore(app_dir), symlinks=True)
    write_json(stage_dir / "theme.json", theme)
    write_json(stage_dir / "theme-built.json", meta)
    write_json(stage_dir / "nsh.json", manifest)
    # The sidebar stage art (nightly / blueprint) is themed too (SidebarStageBackdrop.tsx): a custom
    # theme never shows it (themeAllowsSidebarArtwork), so build_stage_art leaves those files as the
    # copytree above staged them (the checked-in Ocean default) and only the five built-in ids repaint.
    # Imported here, not at module load: run_local.py puts tools/ itself on sys.path (this module
    # loads bare, as "build_theme"), while pytest imports this module as "tools.build_theme"; either
    # layout makes one of these two spellings resolve.
    try:
        from tools import build_stage_art
    except ImportError:
        import build_stage_art
    build_stage_art.write_stage_art(
        stage_dir / "components" / "sidebar" / "stage", meta["light"], meta["dark"], sources.css_text)
    return meta


def read_request_file(path: Path):
    """The normalized request in `path`, None when there is no file. The app writes it; it must be a plain
    file of this user. Raises ThemeError for one that cannot be used."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    import stat as stat_module
    if not stat_module.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > MAX_REQUEST_BYTES:
        raise ThemeError("The theme request file is not a usable file")
    try:
        return normalize_request(json.loads(path.read_text()))
    except json.JSONDecodeError as exc:
        raise ThemeError(f"The theme request is not valid JSON: {exc}") from exc
    except FileNotFoundError:
        return None


def request_id_of(path: Path) -> str:
    """The requestId of a file too damaged to normalize, so the failure can still be reported against it."""
    try:
        value = json.loads(path.read_text()).get("requestId", "")
        return value if isinstance(value, str) else ""
    except (OSError, ValueError, AttributeError):
        return ""


def write_status(path: Path, request_id: str, ok: bool, message: str = "") -> None:
    import time
    write_json(path, {"requestId": request_id, "ok": ok, "message": message, "at": int(time.time() * 1000)})


class LauncherThemes:
    """The launcher's side of the theme request channel (see tools/run_local.py).

    `bootstrap_dir` holds the app's request and our status; `stage_dir` the current build copy and
    `stage_dir.with_name(name + ".next")` the one being tried. `entry` is what to hand to `nsh build`.
    """

    def __init__(self, bootstrap_dir: Path, stage_dir: Path, app_entry: Path):
        self.request_path = bootstrap_dir / REQUEST_FILE
        self.status_path = bootstrap_dir / STATUS_FILE
        # Persistence only (LAST_FILE): preferred over request_path at start() so a live apply's
        # choice (which never writes request_path) still survives a restart.
        self.last_path = bootstrap_dir / LAST_FILE
        self.stage_dir = stage_dir
        self.pending_dir = stage_dir.with_name(stage_dir.name + ".next")
        self.app_entry = Path(app_entry)
        self.sources = None
        self.meta = None          # what the running window shows
        self.shown = None         # effective() of that
        self.seen = self._stamp()
        self.entry = self.app_entry

    def _stamp(self):
        try:
            info = self.request_path.lstat()
        except OSError:
            return None
        return (info.st_mtime_ns, info.st_size)

    def _sources(self) -> Sources:
        if self.sources is None:
            self.sources = Sources()
        return self.sources

    def start(self) -> None:
        """Build inputs for the first window: the last saved request, else Ocean. A request that cannot be
        used falls back to the default theme, and no theme sources at all to the plain app.

        `last_path` (LAST_FILE) is tried first: a live apply persists the choice there without ever
        writing `request_path` (REQUEST_FILE), so the next launch's themed first build still shows it;
        `request_path` is the fallback for a session that only ever used the rebuild path (no
        LAST_FILE yet) or an older saved one."""
        self.seen = self._stamp()
        request = None
        for path in (self.last_path, self.request_path):
            try:
                request = read_request_file(path)
            except ThemeError as exc:
                print(f"Ignoring the saved theme request ({path.name}): {exc}", flush=True)
                continue
            if request is not None:
                break
        for candidate in ([request] if request else []) + [default_request()]:
            if effective(candidate) == effective(default_request()):
                # The repo's own theme.json is Ocean at contrast 100: build the plain app, never a copy.
                self.meta = {"light": DEFAULT_THEME_ID, "dark": DEFAULT_THEME_ID, "contrast": DEFAULT_CONTRAST}
                self.shown = effective(candidate)
                self.entry = self.app_entry
                return
            try:
                self.meta = stage_theme_build(self.app_entry, self.stage_dir, candidate, self._sources())
            except (ThemeError, OSError, ValueError) as exc:
                print(f"Theme not applied ({exc})", flush=True)
                continue
            self.shown = effective(candidate)
            self.entry = self.stage_dir / self.app_entry.name
            self.request = candidate
            return

    def use_default(self) -> None:
        """The themed copy could not be built whole: the window runs the plain app, Ocean."""
        self.meta = {"light": DEFAULT_THEME_ID, "dark": DEFAULT_THEME_ID, "contrast": DEFAULT_CONTRAST}
        self.shown = effective(default_request())
        self.entry = self.app_entry

    def refresh(self) -> None:
        """A reload with no new theme: the themed build is a copy of the app folder, so it is copied again from
        the sources. Without this a reload of a themed window rebuilt the sources as they were when the theme was picked."""
        request = getattr(self, "request", None)
        if request is None or self.entry == self.app_entry:
            return
        try:
            stage_theme_build(self.app_entry, self.stage_dir, request, self._sources())
        except (ThemeError, OSError, ValueError) as exc:
            print(f"The themed copy could not be refreshed ({exc}); reloading the last copy", flush=True)

    def changed(self) -> bool:
        stamp = self._stamp()
        if stamp is None or stamp == self.seen:
            return False
        self.seen = stamp
        return True

    def prepare(self):
        """Stage the request on disk beside the current copy: (entry, meta, request_id), or None when it
        asks for what is already showing. Raises ThemeError; reports it against the request."""
        try:
            request = read_request_file(self.request_path)
        except ThemeError as exc:
            self.report(request_id_of(self.request_path), False, str(exc))
            raise
        if request is None:
            return None
        if self.shown is not None and effective(request) == self.shown:
            self.report(request["requestId"], True)
            return None
        if effective(request) == effective(default_request()):
            self.pending = (request, effective(request))
            self.pending_plain = True
            return self.app_entry, {"light": DEFAULT_THEME_ID, "dark": DEFAULT_THEME_ID, "contrast": DEFAULT_CONTRAST}, request["requestId"]
        self.pending_plain = False
        try:
            meta = stage_theme_build(self.app_entry, self.pending_dir, request, self._sources())
        except (ThemeError, OSError, ValueError) as exc:
            self.report(request["requestId"], False, str(exc))
            raise ThemeError(str(exc)) from exc
        self.pending = (request, effective(request))
        return self.pending_dir / self.app_entry.name, meta, request["requestId"]

    def commit(self, meta: dict, request_id: str) -> None:
        """The pending copy built and its window is up: it is now the current one."""
        import shutil
        self.meta = meta
        self.shown = self.pending[1]
        if getattr(self, "pending_plain", False):
            self.entry = self.app_entry
        else:
            shutil.rmtree(self.stage_dir, ignore_errors=True)
            os.replace(self.pending_dir, self.stage_dir)
            self.entry = self.stage_dir / self.app_entry.name
            self.request = self.pending[0]
        self.report(request_id, True)

    def report(self, request_id: str, ok: bool, message: str = "") -> None:
        try:
            write_status(self.status_path, request_id, ok, message)
        except OSError:
            pass


class LiveThemeWatcher:
    """The live-apply fast path: a background thread of its own, independent of `LauncherThemes`'
    rebuild loop (~0.5 s, `run_local.py`'s `app.wait(timeout=0.5)`), so a host that can apply theme
    tokens live (`theme.setOverrides`, third_party/nsh-host/README.md "live theme") is not held to
    that cadence. Watches `LIVE_REQUEST_FILE` (the app writes it instead of `REQUEST_FILE` once its
    `nsh/host` reports `available()`), regenerates the same theme.json shape `build_theme` makes for
    a rebuild, and answers in `LIVE_RESULT_FILE` / `LIVE_STATUS_FILE`. The app itself applies the
    result (`host.call("theme.setOverrides", ...)`): this thread only generates and hands it over,
    same as `LauncherThemes.start()` does for the themed first build (one generator, two delivery
    paths, per the live-theme README's choice (a)).

    `sources` is a zero-argument callable returning the (cached) `Sources`: `LauncherThemes._sources`
    fits directly, so both paths share the one load of the reference theme sources.
    """

    POLL_SECONDS = 0.02

    def __init__(self, bootstrap_dir: Path, sources) -> None:
        self.request_path = bootstrap_dir / LIVE_REQUEST_FILE
        self.result_path = bootstrap_dir / LIVE_RESULT_FILE
        self.status_path = bootstrap_dir / LIVE_STATUS_FILE
        self._sources = sources
        self._seen = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="live-theme-watcher", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)

    def _stamp(self):
        try:
            info = self.request_path.lstat()
        except OSError:
            return None
        return (info.st_mtime_ns, info.st_size)

    def _run(self) -> None:
        while not self._stop.is_set():
            stamp = self._stamp()
            if stamp is not None and stamp != self._seen:
                self._seen = stamp
                self._handle()
            self._stop.wait(self.POLL_SECONDS)

    def _handle(self) -> None:
        request_id = request_id_of(self.request_path)
        try:
            request = read_request_file(self.request_path)
        except ThemeError as exc:
            self._report(request_id, False, str(exc))
            return
        if request is None:
            return
        try:
            theme, meta = build_theme(request, self._sources())
            write_json(self.result_path, {"requestId": request["requestId"], "theme": theme, "meta": meta})
        except Exception as exc:  # the watcher thread must never die on a bad request or a write race
            self._report(request["requestId"], False, str(exc))
            return
        self._report(request["requestId"], True)

    def _report(self, request_id: str, ok: bool, message: str = "") -> None:
        try:
            write_status(self.status_path, request_id, ok, message)
        except OSError:
            pass


def write_json(path: Path, value) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, indent=2) + "\n")
    os.replace(tmp, path)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--light", default=DEFAULT_THEME_ID)
    parser.add_argument("--dark", default=DEFAULT_THEME_ID)
    parser.add_argument("--contrast", type=int, default=DEFAULT_CONTRAST)
    parser.add_argument("--request", help="a theme-request.json to build instead of the flags")
    parser.add_argument("--out", required=True, help="where to write theme.json")
    args = parser.parse_args(argv)
    if args.request:
        raw = json.loads(Path(args.request).read_text())
    else:
        raw = {"themeLight": args.light, "themeDark": args.dark, "contrast": args.contrast}
    theme, meta = build_theme(normalize_request(raw), Sources())
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    write_json(out, theme)
    print(f"wrote {out}: light={meta['light']} dark={meta['dark']} contrast={meta['contrast']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
