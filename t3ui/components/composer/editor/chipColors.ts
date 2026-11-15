// The inline tokens' ink (lib/contextChipAccents.ts + themePalette.ts contextChipVariables): each kind's
// OKLCH accent with its lightness solved for 5:1 contrast on the composer's surfaces, lighter on a dark theme.
export const CHIP_ACCENTS = {
  file: [0.62, 0.136, 237],
  mention: [0.62, 0.11, 215],
  skill: [0.62, 0.16, 322],
  model: [0.62, 0.13, 105],
  thread: [0.62, 0.12, 190],
  terminal: [0.62, 0.134, 163],
  "preview-annotation": [0.62, 0.134, 70],
  "pull-request": [0.62, 0.16, 277],
  citation: [0.62, 0.16, 259],
} as const;

export type ChipAccent = keyof typeof CHIP_ACCENTS;

type Rgb = [number, number, number];

function oklchToRgb(L: number, C: number, h: number): Rgb {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((value) => {
    const v = Math.min(1, Math.max(0, value));
    return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
  }) as Rgb;
}

const luminance = ([r, g, b]: Rgb) => {
  const channel = (value: number) => { const v = value / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (x: Rgb, y: Rgb) => { const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p); return (hi! + 0.05) / (lo! + 0.05); };
const hex = (rgb: Rgb) => `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;

/** `kind`'s ink on `surface` (an `rgb(...)` or `#rrggbb` color). */
export function chipInk(kind: ChipAccent, surface: Rgb, minContrast = 5): string {
  return accentInk(CHIP_ACCENTS[kind], surface, minContrast);
}

/** An OKLCH accent's ink on `surface`: only the lightness moves until it reads at `minContrast`. */
export function accentInk(accent: readonly [number, number, number], surface: Rgb, minContrast = 5): string {
  const [L, C, h] = accent;
  if (contrast(oklchToRgb(L, C, h), surface) >= minContrast) return hex(oklchToRgb(L, C, h));
  const lighter = luminance(surface) < 0.179;
  let low = lighter ? L : 0;
  let high = lighter ? 1 : L;
  for (let step = 0; step < 18; step += 1) {
    const mid = (low + high) / 2;
    const ok = contrast(oklchToRgb(mid, C, h), surface) >= minContrast;
    if (lighter === ok) high = mid; else low = mid;
  }
  return hex(oklchToRgb(lighter ? high : low, C, h));
}

/** The ink that reads on every one of `surfaces` (contextChipVariables solves against canvas, surface and raised surface together). */
export function accentInkOnAll(accent: readonly [number, number, number], surfaces: Rgb[], minContrast = 5): string {
  const dark = luminance(surfaces[0]!) < 0.179;
  const inks = surfaces.map((surface) => accentInk(accent, surface, minContrast));
  const lum = (value: string) => luminance([1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16)) as Rgb);
  return inks.reduce((best, ink) => ((dark ? lum(ink) > lum(best) : lum(ink) < lum(best)) ? ink : best));
}
