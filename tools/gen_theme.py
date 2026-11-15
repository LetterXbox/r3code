#!/usr/bin/env python3
"""Generate Rust theme constants from t3code's apps/web/src/index.css tokens.

Resolves var() chains, the handful of color-mix() forms actually used,
oklch()/hex/rgb() colors, and --alpha() shorthand. Emits light + dark palettes
so the GPUI port can be pixel-grounded in the same numbers the web app uses.
"""
import math, re, sys, json

CSS = sys.argv[1]

def hex_to_rgb(s):
    s = s.strip().lstrip('#')
    if len(s) == 3: s = ''.join(c*2 for c in s)
    return tuple(int(s[i:i+2], 16) for i in (0, 2, 4))

def oklch_to_srgb(L, C, H):
    h = math.radians(H)
    a = C * math.cos(h); b = C * math.sin(h)
    l_ = L + 0.3963377774*a + 0.2158037573*b
    m_ = L - 0.1055613458*a - 0.0638541728*b
    s_ = L - 0.0894841775*a - 1.2914855480*b
    l, m, s = l_**3, m_**3, s_**3
    r =  4.0767416621*l - 3.3077115913*m + 0.2309699292*s
    g = -1.2684380046*l + 2.6097574011*m - 0.3413193965*s
    bb= -0.0041960863*l - 0.7034186147*m + 1.7076147010*s
    def enc(c):
        c = max(0.0, min(1.0, c))
        return 12.92*c if c <= 0.0031308 else 1.055*(c**(1/2.4)) - 0.055
    return tuple(round(enc(v)*255) for v in (r, g, bb))

TAILWIND = {  # minimal palette subset the app references
 'zinc-25': (252,252,252), 'zinc-50': (250,250,250), 'zinc-100': (244,244,245),
 'zinc-200': (228,228,231), 'zinc-300': (212,212,216), 'zinc-400': (161,161,170),
 'zinc-500': (113,113,122), 'zinc-600': (82,82,91), 'zinc-700': (63,63,70),
 'zinc-800': (39,39,42), 'zinc-900': (24,24,27), 'zinc-950': (9,9,11),
 'white': (255,255,255), 'black': (0,0,0),
 'neutral-100': (245,245,245), 'neutral-200': (229,229,229), 'neutral-300': (212,212,212),
 'neutral-400': (163,163,163), 'neutral-500': (115,115,115), 'neutral-800': (38,38,38),
 'neutral-900': (23,23,23), 'neutral-950': (10,10,10),
 'red-400': (248,113,113), 'red-500': (239,68,68), 'red-700': (185,28,28),
 'blue-400': (96,165,250), 'blue-500': (59,130,246), 'blue-700': (29,78,216),
 'emerald-500': (16,185,129), 'emerald-700': (4,120,87), 'emerald-400': (52,211,153),
 'amber-400': (251,191,36), 'amber-500': (245,158,11), 'amber-700': (180,83,9),
 'fuchsia-300': (240,171,252), 'fuchsia-500': (217,70,239), 'fuchsia-600': (192,38,211),
}

VAR_RE = re.compile(r'var\((--[a-z0-9-]+)(?:,\s*([^)]+))?\)')

def parse_color(v, defs, depth=0):
    """Return (r,g,b,a) or None."""
    if depth > 12: return None
    v = v.strip().rstrip(';')
    if v.startswith('color-mix'):
        return parse_mix(v, defs, depth + 1)
    m = VAR_RE.fullmatch(v)
    if m:
        name = m.group(1)
        if name in defs: return parse_color(defs[name], defs, depth+1)
        # var(--color-zinc-200) style: resolve through the Tailwind palette.
        tm = re.fullmatch(r'--color-([a-z]+-\d+|white|black)', name)
        if tm:
            c = TAILWIND.get(tm.group(1))
            if c: return c + (1.0,)
        return None
    m = re.fullmatch(r'--alpha\(\s*(.+?)\s*/\s*([\d.]+)%\s*\)', v)
    if m:
        base = parse_color(m.group(1), defs, depth+1)
        if not base: return None
        return (base[0], base[1], base[2], float(m.group(2))/100)
    m = re.fullmatch(r'#([0-9a-fA-F]{3,8})', v)
    if m:
        h = m.group(1)
        if len(h) in (3, 6): return hex_to_rgb(h) + (1.0,)
        return hex_to_rgb(h[:6]) + (int(h[6:8],16)/255,)
    m = re.fullmatch(r'oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)\s*\)', v)
    if m:
        L = float(m.group(1)); L = L/100 if L > 1 else L
        return oklch_to_srgb(L, float(m.group(2)), float(m.group(3))) + (1.0,)
    m = re.fullmatch(r'rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:/\s*([\d.]+)%\s*)?\)', v)
    if m:
        a = float(m.group(4))/100 if m.group(4) else 1.0
        return (int(m.group(1)), int(m.group(2)), int(m.group(3)), a)
    m = re.fullmatch(r'--color-([a-z]+-\d+|white|black)', v)
    if m:
        c = TAILWIND.get(m.group(1))
        if c: return c + (1.0,)
    if v == 'transparent': return (0, 0, 0, 0.0)
    return None

def parse_mix(v, defs, depth=0):
    """color-mix(in srgb, A P%, B) -> blended rgba"""
    m = re.fullmatch(r'color-mix\(in srgb,\s*(.+)\)', v.strip(), re.S)
    if not m: return None
    inner = m.group(1)
    # split top-level commas
    parts, buf, d = [], '', 0
    for ch in inner:
        if ch == '(': d += 1
        if ch == ')': d -= 1
        if ch == ',' and d == 0:
            parts.append(buf); buf = ''
        else: buf += ch
    parts.append(buf)
    if len(parts) != 2: return None
    out = []
    for p in parts:
        p = p.strip()
        pm = re.fullmatch(r'(.+?)\s+([\d.]+)%', p, re.S)
        pct = None
        if pm: p, pct = pm.group(1), float(pm.group(2))
        else: pct = None
        c = parse_color(p, defs, depth+1) if not p.startswith('color-mix') else parse_mix(p, defs, depth+1)
        if not c: return None
        out.append((c, pct))
    (c1, p1), (c2, p2) = out
    # CSS: a missing percentage takes the remainder of the other operand.
    if p1 is not None and p2 is None: p2 = 100.0 - p1
    elif p2 is not None and p1 is None: p1 = 100.0 - p2
    elif p1 is None and p2 is None: p1 = p2 = 50.0
    tot = p1 + p2
    w1, w2 = p1/tot, p2/tot
    return tuple(round(c1[i]*w1 + c2[i]*w2) for i in range(3)) + (round(c1[3]*w1 + c2[3]*w2, 3),)

def _main():
    pass


def _load():
    return open(CSS).read()

css = open(CSS).read()
# Pick the :root block that actually declares the color tokens (not the
# geometry-only block earlier in the file).
def block_at(text, start):
    d = 0
    for j in range(start, len(text)):
        if text[j] == '{': d += 1
        elif text[j] == '}':
            d -= 1
            if d == 0: return text[start:j+1]
    return text[start:]
root = None
for m in re.finditer(r'^:root\s*\{', css, re.M):
    b = block_at(css, m.start())
    if '--background' in b and '@variant dark' in b:
        root = b
        break
assert root, 'no token :root block found'
# keep only the dark @variant sub-block for the dark pass
_i = root.index('@variant dark')
_d = 0
_end = len(root)
for j in range(_i, len(root)):
    if root[j] == '{': _d += 1
    elif root[j] == '}':
        _d -= 1
        if _d == 0:
            _end = j
            break
dark_sub = root[_i:_end]

def collect(block):
    """Collect --name: value; declarations, tolerating nested parens and newlines."""
    d = {}
    i, n = 0, len(block)
    while i < n:
        m = re.compile(r'--[a-z0-9-]+\s*:').search(block, i)
        if not m: break
        name = m.group(0).split(':')[0].strip()
        j = m.end()
        depth, buf = 0, []
        while j < n:
            ch = block[j]
            if ch == '(': depth += 1
            elif ch == ')': depth -= 1
            elif ch == ';' and depth == 0: break
            elif ch == '}' and depth == 0: break
            buf.append(ch)
            j += 1
        val = ' '.join(''.join(buf).split())
        if val: d[name] = val
        i = j + 1
    return d

light = collect(root.replace(dark_sub, ''))
dark = dict(light)
# dark variant block inside :root
# The @variant dark block only overrides part of the palette; every token it
# omits keeps its light value, exactly as CSS cascade does.
dark_overrides = collect(dark_sub)
dark.update(dark_overrides)

def emit(name, defs):
    lines = []
    for k in sorted(defs):
        if not re.fullmatch(r'--(background|foreground|card|card-foreground|popover|popover-foreground|primary|primary-foreground|secondary|secondary-foreground|muted|muted-foreground|placeholder|secondary-label|icon-muted|message-surface|message-foreground|message-action|accent|accent-foreground|error|error-foreground|error-surface|destructive|destructive-foreground|border|input|ring|info|info-foreground|success|success-foreground|warning|warning-foreground|warning-surface|sidebar|sidebar-foreground|sidebar-muted-foreground|sidebar-control-surface|sidebar-row-hover|sidebar-row-active|sidebar-row-selected|sidebar-border|code-background|code-foreground|terminal-background|terminal-foreground|tool-error-icon|surface-raised|guest|guest-foreground)', k):
            continue
        v = defs[k]
        c = parse_mix(v, defs) if v.startswith('color-mix') else parse_color(v, defs)
        if not c:
            continue
        r, g, b, a = c
        if a < 1.0:
            lines.append(f'    pub const {k[2:].replace("-","_").upper()}: Rgba = Rgba {{ r: {r}, g: {g}, b: {b}, a: {a} }}; // {v[:60]}')
        else:
            lines.append(f'    pub const {k[2:].replace("-","_").upper()}: Rgba = Rgba {{ r: {r}, g: {g}, b: {b}, a: 1.0 }}; // {v[:60]}')
    return '\n'.join(lines)

print(emit('light', light))
print('---DARK---')
print(emit('dark', dark))
