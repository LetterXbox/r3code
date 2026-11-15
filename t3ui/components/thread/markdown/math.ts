// Typeset formulas, the way the web app shows them (chat/MathTypeset.tsx, KaTeX), without a DOM: MathJax's TeX input and SVG
// output (mathjax-full 3.2.2, Apache-2.0, bundled as t3ui/vendor/mathjax/tex2svg.js from entry.mjs.txt) turn the TeX into a
// self-contained SVG whose glyphs are paths, which the app shows as an image. A formula MathJax cannot read keeps its TeX source,
// as the web app's does while KaTeX is loading or cannot parse (MarkdownMath.tsx).
// @ts-ignore vendored build without types
import { texToSvg } from "../../../vendor/mathjax/tex2svg.js";

export type MathResult = { ok: true; url: string; width: number; height: number; depth: number } | { ok: false; source: string };

/** The TeX source as the web app shows it when it cannot typeset: `\[ ... \]` for a block, `\( ... \)` inside text. */
export function mathSource(tex: string, display: boolean): string {
  const trimmed = tex.trim();
  return display ? `\\[\n${trimmed}\n\\]` : `\\(${trimmed}\\)`;
}

const cache = new Map<string, MathResult>();

/** MathJax measures in ex at its 8-units-per-16-unit-em ratio, so one ex is half the font size. */
export function exToPoints(ex: number, fontSize: number): number {
  return ex * fontSize * 0.5;
}

/** Rewrites MathJax's standalone svg for an image: sizes in points, glyphs in `color` (an image cannot inherit currentColor). */
export function prepareMathSvg(svg: string, fontSize: number, color: string): { svg: string; width: number; height: number; depth: number } | null {
  const width = /<svg[^>]*\swidth="([\d.]+)ex"/.exec(svg)?.[1];
  const height = /<svg[^>]*\sheight="([\d.]+)ex"/.exec(svg)?.[1];
  const align = /vertical-align:\s*(-?[\d.]+)ex/.exec(svg)?.[1];
  if (!width || !height) return null;
  const pointsWide = exToPoints(Number(width), fontSize);
  const pointsHigh = exToPoints(Number(height), fontSize);
  const depth = Math.max(0, -exToPoints(Number(align ?? 0), fontSize));
  const out = svg
    .replace(/(<svg[^>]*\s)width="[\d.]+ex"/, `$1width="${pointsWide}"`)
    .replace(/(<svg[^>]*\s)height="[\d.]+ex"/, `$1height="${pointsHigh}"`)
    .replace(/(<svg[^>]*?)\sstyle="[^"]*"/, "$1")
    .replace(/currentColor/g, color);
  return { svg: out, width: pointsWide, height: pointsHigh, depth };
}

/** The formula as an SVG data URL, sized for `fontSize`, or its source when it cannot be typeset. */
export function renderMath(tex: string, display: boolean, fontSize: number, color: string): MathResult {
  const trimmed = tex.trim();
  const key = `${display ? "d" : "i"}|${fontSize}|${color}|${trimmed}`;
  const cached = cache.get(key);
  if (cached) return cached;
  let result: MathResult;
  try {
    if (trimmed === "") throw new Error("empty");
    const prepared = prepareMathSvg(String(texToSvg(trimmed, display)), fontSize, color);
    if (!prepared || /data-mjx-error|<merror/.test(prepared.svg)) throw new Error("unreadable");
    result = { ok: true, url: `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(prepared.svg)))}`, width: prepared.width, height: prepared.height, depth: prepared.depth };
  } catch {
    result = { ok: false, source: mathSource(trimmed, display) };
  }
  if (cache.size > 300) cache.clear();
  cache.set(key, result);
  return result;
}
