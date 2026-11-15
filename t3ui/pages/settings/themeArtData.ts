// The pictures of the Appearance page as plain data, ported from the reference:
// ThemeWireframe.tsx (the System / Light / Dark tiles), ThemePreviewCircles.tsx
// (the gradient spheres) and packages/shared/src/themePreview.ts (the sphere's
// render spec and its oklab base mix). ThemeArt.tsx paints this data on a Canvas;
// keeping it pure lets a test assert it.
import type { ThemeAppearance, ThemePreviewColors } from "../../themePreviews";

/** rgb(127 127 127 / 0.25), the wireframe's hairline and placeholder bars. */
export const WIREFRAME_LINE = "rgba(127,127,127,0.25)";
// Tailwind radii at the theme's 8px radius: rounded-sm, -md, -lg.
const SM = 4;
const MD = 6;
const LG = 8;

export type WireShape =
  | { kind: "rect"; x: number; y: number; w: number; h: number; radius: number; fill: string; opacity?: number; ring?: boolean; shadow?: boolean }
  | { kind: "circle"; cx: number; cy: number; d: number; fill: string; opacity?: number }
  | { kind: "edge"; x: number };

/**
 * One wireframe pane, fractions of the pane (x, w of its width; y, h of its height; a circle's
 * diameter d is a fraction of its height). `aspect` is width / height, so a circle and the
 * `gap-1` offsets stay round and 4pt wide.
 */
export function wireframeShapes(colors: ThemePreviewColors, aspect = 1.6): WireShape[] {
  const shapes: WireShape[] = [];
  const rect = (x: number, y: number, w: number, h: number, radius: number, fill: string, extra: Partial<Extract<WireShape, { kind: "rect" }>> = {}) =>
    shapes.push({ kind: "rect", x, y, w, h, radius, fill, ...extra });
  rect(0, 0, 1, 1, 0, colors.canvas);
  rect(0, 0, 0.22, 1, 0, colors.sidebar);
  shapes.push({ kind: "edge", x: 0.22 });
  rect(0.03, 0.08, 0.16, 0.08, MD, colors.surface, { ring: true });
  rect(0.03, 0.22, 0.16, 0.07, MD, colors.accentSurface);
  rect(0.03, 0.32, 0.16, 0.07, MD, colors.messageSurface, { opacity: 0.7 });
  rect(0.03, 0.42, 0.16, 0.07, MD, colors.messageSurface, { opacity: 0.5 });
  // right-[28%] w-[24%]
  rect(1 - 0.28 - 0.24, 0.11, 0.24, 0.09, LG, colors.messageSurface);
  rect(0.27, 0.28, 0.34, 0.05, SM, WIREFRAME_LINE);
  rect(0.27, 0.38, 0.26, 0.05, SM, WIREFRAME_LINE);
  // The composer: bottom-[8%] left-[26%] right-[6%] h-[15%] px-1, a pill at the start, the action at the end.
  const cx = 0.26;
  const cw = 1 - 0.26 - 0.06;
  const cy = 1 - 0.08 - 0.15;
  const ch = 0.15;
  rect(cx, cy, cw, ch, MD, colors.surface, { ring: true });
  const pad = 4 / (aspect * 100);
  rect(cx + pad * 2.5, cy + ch * 0.37, cw * 0.34, ch * 0.26, 99, WIREFRAME_LINE, { opacity: 0.7 });
  const actionD = ch * 0.58;
  shapes.push({ kind: "circle", cx: cx + cw - pad * 2.5 - (actionD / aspect) / 2, cy: cy + ch / 2, d: actionD, fill: colors.messageAction });
  // The details card: right-[5%] top-[8%] h-[46%] w-[20%], three rows.
  const px = 1 - 0.05 - 0.2;
  const py = 0.08;
  const ph = 0.46;
  const pw = 0.2;
  rect(px, py, pw, ph, LG, colors.surface, { ring: true, shadow: true });
  const dots = ["#34d399", colors.messageAction, "#fbbf24"];
  dots.forEach((dot, row) => {
    const ry = py + ph * ((10 + row * 30) / 100);
    const rh = ph * 0.2;
    const rx = px + pw * 0.11;
    const rw = pw * 0.78;
    const d = rh * 0.26;
    shapes.push({ kind: "circle", cx: rx + d / aspect / 2, cy: ry + rh / 2, d, fill: dot, opacity: 0.55 });
    rect(rx + d / aspect + pad, ry + rh * 0.35, rw * 0.52, rh * 0.3, SM, WIREFRAME_LINE);
  });
  return shapes;
}

/** The two halves of a System tile: the light pane keeps the left, the dark pane the right (1px gap each side of the middle). */
export function wireframePanes(mode: "system" | ThemeAppearance): { appearance: ThemeAppearance; clip: "left" | "right" | null }[] {
  if (mode === "system") return [{ appearance: "light", clip: "left" }, { appearance: "dark", clip: "right" }];
  return [{ appearance: mode, clip: null }];
}

// --- the gradient spheres ---------------------------------------------------

export interface ThemePreviewRenderSpec {
  baseTarget: string;
  baseWeight: number;
  accent: { center: [number, number]; middleOffset: number; middleOpacity: number; endOffset: number };
  action: { center: [number, number]; startOpacity: number; endOffset: number };
  scale: number;
  blurAt56Px: number;
}

/** THEME_PREVIEW_RENDER_SPECS (packages/shared/src/themePreview.ts). */
export const THEME_PREVIEW_RENDER_SPECS: Record<ThemeAppearance, ThemePreviewRenderSpec> = {
  light: {
    baseTarget: "#ffffff",
    baseWeight: 0.8,
    accent: { center: [0.72, 0.22], middleOffset: 0.28, middleOpacity: 0.72, endOffset: 0.58 },
    action: { center: [0.18, 0.82], startOpacity: 0.45, endOffset: 0.55 },
    scale: 1.1,
    blurAt56Px: 3,
  },
  dark: {
    baseTarget: "#09090b",
    baseWeight: 0.8,
    accent: { center: [0.28, 0.78], middleOffset: 0.28, middleOpacity: 0.62, endOffset: 0.58 },
    action: { center: [0.82, 0.18], startOpacity: 0.45, endOffset: 0.55 },
    scale: 1.1,
    blurAt56Px: 3,
  },
};

type Oklab = { l: number; a: number; b: number };
const HEX = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i;

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v: number) => Math.round(Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)) * 255);

function parseOklab(value: string): Oklab | null {
  const m = HEX.exec(value);
  if (!m) return null;
  const r = toLinear(parseInt(m[1]!, 16) / 255);
  const g = toLinear(parseInt(m[2]!, 16) / 255);
  const b = toLinear(parseInt(m[3]!, 16) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s,
  };
}

function oklabToHex(c: Oklab): string {
  const lp = c.l + 0.3963377774 * c.a + 0.2158037573 * c.b;
  const mp = c.l - 0.1055613458 * c.a - 0.0638541728 * c.b;
  const sp = c.l - 0.0894841775 * c.a - 1.291485548 * c.b;
  const l = lp ** 3;
  const m = mp ** 3;
  const s = sp ** 3;
  const ch = [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
  return `#${ch.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** mixThemePreviewBase: the canvas colour mixed in oklab toward the mode's base target. */
export function mixThemePreviewBase(canvasHex: string, mode: ThemeAppearance): string {
  const spec = THEME_PREVIEW_RENDER_SPECS[mode];
  const canvas = parseOklab(canvasHex);
  const target = parseOklab(spec.baseTarget);
  if (!canvas || !target) return canvasHex;
  const w = spec.baseWeight;
  return oklabToHex({ l: canvas.l * w + target.l * (1 - w), a: canvas.a * w + target.a * (1 - w), b: canvas.b * w + target.b * (1 - w) });
}

/** A hex colour at an alpha, for gradient stops (a canvas gradient interpolates unpremultiplied, so `transparent` must keep the colour). */
export function hexAlpha(hex: string, alpha: number): string {
  const m = HEX.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)},${Math.round(alpha * 1000) / 1000})`;
}

export interface SphereGradient {
  /** Centre, fractions of the sphere's box. */
  center: [number, number];
  /** CSS `circle` sizing: the distance to the farthest corner, a fraction of the box's side. */
  radius: number;
  stops: { offset: number; color: string }[];
}

export interface SphereSpec {
  base: string;
  /** Painted bottom to top: the action glow, then the accent. */
  gradients: SphereGradient[];
  scale: number;
  /** The CSS blur at 56px; the Canvas draws without it (no filter), the spheres are soft already. */
  blur: number;
  edge: string;
}

function farthestCorner(c: [number, number]): number {
  return Math.hypot(Math.max(c[0], 1 - c[0]), Math.max(c[1], 1 - c[1]));
}

/** The reference's getThemePreviewStyle as canvas data. */
export function sphereSpec(colors: ThemePreviewColors, mode: ThemeAppearance): SphereSpec {
  const spec = THEME_PREVIEW_RENDER_SPECS[mode];
  return {
    base: mixThemePreviewBase(colors.canvas, mode),
    gradients: [
      {
        center: spec.action.center,
        radius: farthestCorner(spec.action.center),
        stops: [
          { offset: 0, color: hexAlpha(colors.messageAction, spec.action.startOpacity) },
          { offset: spec.action.endOffset, color: hexAlpha(colors.messageAction, 0) },
        ],
      },
      {
        center: spec.accent.center,
        radius: farthestCorner(spec.accent.center),
        stops: [
          { offset: 0, color: colors.accent },
          { offset: spec.accent.middleOffset, color: hexAlpha(colors.accent, spec.accent.middleOpacity) },
          { offset: spec.accent.endOffset, color: hexAlpha(colors.accent, 0) },
        ],
      },
    ],
    scale: spec.scale,
    blur: spec.blurAt56Px,
    edge: mode === "dark" ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.10)",
  };
}
