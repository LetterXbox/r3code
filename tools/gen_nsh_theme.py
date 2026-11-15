#!/usr/bin/env python3
"""Emit the NSH app theme (t3ui/theme.json) from t3code's index.css.

Same parser, same numbers as tools/gen_theme.py, so the NSH screen and the Rust
widgets cannot drift: both are generated from the one stylesheet.

NSH's theme file is `cssVars` with three blocks: `theme` (appearance-neutral
values such as radius), `light` and `dark`. Tokens may reference each other with
`var(--name)`, which NSH resolves — so we keep T3's var() structure instead of
flattening it, and only convert the colors NSH cannot parse itself.
"""
import json, re, sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# The reference stylesheet. The generator reads it from the sibling t3code checkout (read only).
DEFAULT_CSS = os.environ.get('T3_INDEX_CSS') or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', '..', 't3code', 'apps', 'web', 'src', 'index.css')
# gen_theme runs its CLI on import (it reads sys.argv[1] as the stylesheet path); borrow only its
# colour parser and swallow the Rust it would print. Imported as a module, point it at the default.
import contextlib  # noqa: E402
import io  # noqa: E402
_saved_argv = sys.argv
sys.argv = [_saved_argv[0], _saved_argv[1] if __name__ == '__main__' and len(_saved_argv) > 1 else DEFAULT_CSS]
try:
    with contextlib.redirect_stdout(io.StringIO()):
        from gen_theme import parse_color, parse_mix  # noqa: E402
finally:
    sys.argv = _saved_argv


def matching_brace(src, open_idx):
    """Index of the brace closing the one at `open_idx`, or len(src)."""
    d = 0
    for j in range(open_idx, len(src)):
        if src[j] == '{':
            d += 1
        elif src[j] == '}':
            d -= 1
            if d == 0:
                return j
    return len(src)


def collect(src):
    out = {}
    for name, value in re.findall(r'(--[\w-]+)\s*:\s*([^;]+);', src):
        out.setdefault(name, value.strip())
    return out


def parse_css(text):
    """(light_defs, dark_defs) of the token :root of index.css."""
    root = None
    for m in re.finditer(r':root\s*\{', text):
        end = matching_brace(text, m.end() - 1)
        body = text[m.end():end]
        # The token :root is the one declaring --background, not the first :root.
        if '--background' in body:
            root = body
            break
    assert root, 'no :root declaring --background'

    # The @variant dark block inside :root only overrides; it is not a palette.
    dark_sub = ''
    dm = re.search(r'@variant\s+dark\s*\{', root)
    if dm:
        s0 = dm.end() - 1
        dark_sub = root[s0:matching_brace(root, s0) + 1]

    light_defs = collect(root.replace(dark_sub, '') if dark_sub else root)
    dark_defs = dict(light_defs)
    dark_defs.update(collect(dark_sub))
    return light_defs, dark_defs


def css_value(name, defs):
    """Return a CSS color string NSH can parse, resolving what it cannot."""
    v = defs[name]
    if v.startswith('var(') or v.startswith('color-mix(') or v.startswith('oklch('):
        c = parse_mix(v, defs) if v.startswith('color-mix') else parse_color(v, defs)
        if c:
            r, g, b, a = c
            return f'rgba({r},{g},{b},{a:g})' if a < 1.0 else f'rgb({r},{g},{b})'
        return None
    # Plain hex / rgb() / already-resolved form: pass through.
    if re.fullmatch(r'#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)', v.strip()):
        return v.strip()
    c = parse_color(v, defs)
    if not c:
        return None
    r, g, b, a = c
    return f'rgba({r},{g},{b},{a:g})' if a < 1.0 else f'rgb({r},{g},{b})'


INTERFACE_FONT_STACK = '"Bricolage Grotesque UI", -apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", system-ui, sans-serif'


def radius_token(src):
    """T3's --radius, converted to the points NSH's rounded-* scale uses."""
    m = re.search(r'--radius\s*:\s*([\d.]+)rem', src)
    if m:
        return f'{float(m.group(1)) * 16:g}px'
    m = re.search(r'--radius\s*:\s*([\d.]+)px', src)
    return f'{m.group(1)}px' if m else '8px'


def block(defs):
    out = {}
    for k in sorted(defs):
        name = k[2:]
        val = css_value(k, defs)
        if val:
            out[name] = val
    return out


# --- alpha modifiers, flattened -------------------------------------------
# NSH's Tailwind layer applies an alpha modifier *squared*: `bg-card/40` on a
# #111111 card over black paints 17*0.16 = #020202, where CSS says 17*0.40 =
# #070707. The web app leans on those modifiers (`SettingsGroup` is
# `bg-card/40 border-border/60`), so instead of shipping classes that render
# wrong we pre-composite each one into an opaque token here and emit it as
# `<token>-<alpha>`. An opaque colour survives NSH's pipeline byte for byte.
#
# Each entry is (token, alpha, base token the result sits on). The base is the
# surface the element is drawn over, because that is what CSS blends with.
FLATTEN = [
    ('card', 40, 'background'),
    ('border', 60, 'card'),
    ('border', 50, 'card'),
    ('accent', 50, 'card'),
    ('border', 100, 'card'),
    ('input', 100, 'card'),
    ('input', 32, 'card'),
    ('sidebar-row-selected', 100, 'sidebar'),
    ('sidebar-row-hover', 100, 'sidebar'),
    ('sidebar-row-active', 100, 'sidebar'),
    ('muted', 100, 'background'),
    ('muted', 10, 'card'),
    # ProviderInstanceCard's list status line (text-muted-foreground/80)
    ('muted-foreground', 80, 'card'),
    ('accent', 100, 'background'),
    ('popover', 84, 'background'),
    # ThemeLibrary preview well: bg-muted/50 on the settings card.
    ('muted', 50, 'card'),
    # SidebarDraftRow: bg-warning/20, hover:bg-warning/28 on the sidebar.
    ('warning', 20, 'sidebar'),
    ('warning', 28, 'sidebar'),
    # ThreadHeader linked-origin badge: bg-info/28 (light), dark:bg-info/40 on the page.
    ('info', 28, 'background'),
    ('info', 40, 'background'),
    # Alert variant="info" (ui/alert.tsx): border-info/32 bg-info/4 on the page.
    ('info', 32, 'background'),
    ('info', 4, 'background'),
    # DevicePanel's error Notice strip (ui/badge.tsx's error variant, bg-destructive/8) on the right panel's page colour.
    ('destructive', 8, 'background'),
]


def _rgba(val):
    """(r, g, b, a) from an rgb()/rgba()/hex string, else None."""
    m = re.fullmatch(r'#([0-9a-fA-F]{3,8})', val.strip())
    if m:
        h = m.group(1)
        if len(h) == 3:
            h = ''.join(c * 2 for c in h)
        if len(h) == 6:
            return (float(int(h[0:2], 16)), float(int(h[2:4], 16)),
                    float(int(h[4:6], 16)), 1.0)
        if len(h) == 8:
            return (float(int(h[0:2], 16)), float(int(h[2:4], 16)),
                    float(int(h[4:6], 16)), int(h[6:8], 16) / 255.0)
        return None
    m = re.fullmatch(r'rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)', val)
    if not m:
        return None
    r, g, b = (float(m.group(i)) for i in (1, 2, 3))
    a = float(m.group(4)) if m.group(4) is not None else 1.0
    return r, g, b, a


def _over(fg, bg):
    """Composite an (r,g,b,a) colour over an opaque (r,g,b,a) colour."""
    fr, fg_, fb, fa = fg
    br, bg_, bb, _ = bg
    return (
        fr * fa + br * (1 - fa),
        fg_ * fa + bg_ * (1 - fa),
        fb * fa + bb * (1 - fa),
        1.0,
    )


def flattened(defs):
    """Opaque stand-ins for every alpha-modified class the app uses."""
    out = {}
    for token, alpha, base in FLATTEN:
        if '--' + token not in defs or '--' + base not in defs:
            continue
        fgv = css_value('--' + token, defs)
        bgv = css_value('--' + base, defs)
        if not fgv or not bgv:
            continue
        fg, bg = _rgba(fgv), _rgba(bgv)
        if fg is None or bg is None:
            continue
        # The token's own alpha (0.08 for border) times the modifier.
        mixed = (fg[0], fg[1], fg[2], fg[3] * alpha / 100.0)
        r, g, b, _ = _over(mixed, bg)
        # A transparent token leaves the surface alone: skip, the class is a
        # no-op rather than a wrong colour.
        if fg[3] == 0:
            continue
        # At 100% the token is simply opaque, so it keeps its own name; a real
        # modifier gets the suffix the class uses (`card-40` for bg-card/40).
        name = token if alpha == 100 else f'{token}-{alpha}'
        out[name] = f'rgb({round(r)},{round(g)},{round(b)})'
    return out


def app_sidebar_dark_body(src):
    """The `[data-app-sidebar]` dark override, not the page palette."""
    m = re.search(r'\[data-app-sidebar\]\s*\{', src)
    if not m:
        return ''
    block = src[m.end():matching_brace(src, m.end() - 1)]
    dm = re.search(r'@variant\s+dark\s*\{', block)
    if not dm:
        return ''
    return block[dm.end():matching_brace(block, dm.end() - 1)]


def paint_app_sidebar(defs, src):
    """Paint sidebar tokens from `[data-app-sidebar]` dark.

    That block sets the sidebar to #000 and the row fills to
    color-mix(in srgb, var(--contrast-foreground) 7/8/11%, transparent).
    Default appearance contrast is identity (base 100%, boost 0%), and the
    oklab mix is not something parse_mix can resolve, so contrast-foreground
    is the sidebar foreground (#f1f3f7). The mix is rgba(foreground, p)
    painted on the black sidebar. The page palette (card, background) stays
    the general dark theme.
    """
    overlay = collect(app_sidebar_dark_body(src))
    if not overlay:
        return
    local = dict(defs)
    local.update(overlay)
    if '--foreground' in local:
        local['--contrast-foreground'] = local['--foreground']
    for name in (
        '--sidebar',
        '--sidebar-foreground',
        '--sidebar-muted-foreground',
        '--sidebar-control-surface',
        '--sidebar-border',
        '--sidebar-stage-fade',
    ):
        if name not in local:
            continue
        resolved = css_value(name, local)
        if resolved:
            defs[name] = resolved
    fg = parse_color(local.get('--contrast-foreground', ''), local)
    bg = parse_color(local.get('--sidebar', ''), local)
    if not fg or not bg:
        return
    mix = re.compile(
        r'color-mix\(\s*in srgb,\s*var\(--contrast-foreground\)\s+([\d.]+)%\s*,\s*transparent\s*\)'
    )
    for name, value in overlay.items():
        if not name.startswith('--sidebar-row-'):
            continue
        mm = mix.fullmatch(value.strip())
        if not mm:
            resolved = css_value(name, local)
            if resolved:
                defs[name] = resolved
            continue
        a = float(mm.group(1)) / 100.0
        rgb = tuple(round(fg[i] * a + bg[i] * (1.0 - a)) for i in range(3))
        defs[name] = f'rgb({rgb[0]},{rgb[1]},{rgb[2]})'


def base_blocks(text):
    """The T3 Code theme as NSH token blocks: (light, dark, radius), flattened alpha tokens included."""
    light_defs, dark_defs = parse_css(text)
    paint_app_sidebar(dark_defs, text)
    return light_defs, dark_defs


def main():
    css, out = sys.argv[1], sys.argv[2]
    text = open(css).read()
    light_defs, dark_defs = base_blocks(text)
    light_flat = flattened(light_defs)
    dark_flat = flattened(dark_defs)

    theme = {
        'name': 'T3 Code',
        'cssVars': {
            # `font-sans` is the family every Text paints with unless it names another. The owner's
            # interface font is Bricolage Grotesque (bundled as fixed-weight cuts under t3ui/fonts and
            # registered by App.tsx); the rest is the web's --font-sans fallback stack.
            'theme': {'radius': radius_token(text), 'font-sans': INTERFACE_FONT_STACK},
            'light': {**block(light_defs), **light_flat},
            'dark': {**block(dark_defs), **dark_flat},
        },
    }
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, 'w').write(json.dumps(theme, indent=2) + '\n')
    print(f'wrote {out}: {len(theme["cssVars"]["light"])} light, '
          f'{len(theme["cssVars"]["dark"])} dark tokens '
          f'({len(light_flat)} flattened alpha)')


if __name__ == '__main__':
    main()
