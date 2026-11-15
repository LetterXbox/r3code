// Mermaid diagrams, rendered the way the web app does (chat/MermaidDiagram.tsx): the `pele` renderer
// (apps/web dependency, vendored as t3ui/vendor/pele/pele.js, MIT) turns the source into themeable SVG without a DOM.
// A standalone image cannot inherit CSS custom properties, so the `--pele-*` colours the web app takes from the theme
// (index.css `.pele`) are resolved into the SVG here before it becomes an image.
// @ts-ignore vendored build without types
import { detectType, render } from "../../../vendor/pele/pele.js";
// @ts-ignore vendored build without types
import { texToSvg } from "../../../vendor/mathjax/tex2svg.js";
import { prepareMathSvg } from "./math";

/**
 * MermaidDiagram loadMath: pele has no typesetter, so `$$...$$` labels go through the chat's own math engine (MathJax here,
 * KaTeX in the reference). Pele inlines the returned `svg` at the label (A1 `<svg class="pele-math">`); unsupported TeX
 * returns null and stays readable as its source.
 */
export function mermaidMathResolver(color: string): (tex: string, size: number) => { svg: string; width: number; height: number } | null {
  const typeset = new Map<string, { svg: string; width: number; height: number } | null>();
  return (tex, size) => {
    const key = `${size}:${tex}`;
    if (typeset.has(key)) return typeset.get(key)!;
    let markup: { svg: string; width: number; height: number } | null = null;
    try {
      const prepared = prepareMathSvg(String(texToSvg(String(tex).trim(), true)), size, color);
      if (prepared && !/data-mjx-error|<merror/.test(prepared.svg)) markup = { svg: prepared.svg, width: prepared.width, height: prepared.height };
    } catch { /* Unsupported TeX stays readable as its source. */ }
    typeset.set(key, markup);
    return markup;
  };
}

export type PelePalette = Record<string, string>;

/** `--pele-*` from the theme's tokens: index.css `.pele { --pele-bg: var(--background); ... }`. */
export function pelePalette(color: (name: string) => string, mix: (foreground: string, background: string, alpha: number) => string): PelePalette {
  return {
    "--pele-bg": color("background"),
    "--pele-fg": color("foreground"),
    "--pele-muted": color("muted-foreground"),
    "--pele-line": color("muted-foreground"),
    "--pele-surface": color("secondary"),
    "--pele-surface-alt": color("accent"),
    "--pele-border": mix(color("foreground"), color("background"), 0.28),
    "--pele-accent": color("primary"),
    "--pele-critical": color("destructive"),
  };
}

const VARIABLE = /var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/;

/** Replaces every `var(--x, fallback)` using the declarations in the SVG's own styles and the palette; drops the declarations. */
export function resolveSvgVariables(svg: string, palette: PelePalette): string {
  const declared: Record<string, string> = {};
  for (const match of svg.matchAll(/(--[\w-]+)\s*:\s*((?:[^;"()]|\([^()]*\))*)/g)) declared[match[1]] = match[2].trim();
  const lookup = (name: string, fallback: string | undefined, depth: number): string => {
    const own = palette[name] ?? declared[name];
    const value = own ?? fallback ?? "";
    return depth > 8 ? value : substitute(value, depth + 1);
  };
  const substitute = (text: string, depth = 0): string => {
    let current = text;
    for (let guard = 0; guard < 64 && VARIABLE.test(current); guard += 1) current = current.replace(VARIABLE, (_all, name: string, fallback: string | undefined) => lookup(name, fallback, depth));
    return current;
  };
  // Custom property declarations go first so the substitution does not rewrite them.
  const bare = svg.replace(/(--[\w-]+)\s*:\s*((?:[^;"()]|\([^()]*\))*);?/g, "");
  return substitute(bare)
    // `style="rx:4px"` is a geometry property an image renderer reads as an attribute.
    .replace(/<(\w+)([^>]*?)\sstyle="rx:([^";]+);?"([^>]*)>/g, '<$1$2 rx="$3"$4>');
}

/** The size the SVG declares, in points. */
export function svgSize(svg: string): { width: number; height: number } | null {
  const width = /<svg[^>]*\swidth="([\d.]+)"/.exec(svg)?.[1];
  const height = /<svg[^>]*\sheight="([\d.]+)"/.exec(svg)?.[1];
  return width && height ? { width: Number(width), height: Number(height) } : null;
}

export type MermaidResult = { ok: true; url: string; width: number; height: number } | { ok: false; message: string };

const cache = new Map<string, MermaidResult>();

/** The diagram of `source` as an SVG data URL, or the reason it could not be drawn. */
export function renderMermaid(source: string, palette: PelePalette): MermaidResult {
  const trimmed = source.trim();
  const key = `${JSON.stringify(palette)}\n${trimmed}`;
  const cached = cache.get(key);
  if (cached) return cached;
  let result: MermaidResult;
  try {
    if (detectType(trimmed) === null) throw new Error("This is not a diagram type the renderer supports.");
    // The math resolver only joins diagrams that contain math (MermaidDiagram: trimmedSource.includes("$$")).
    const math = trimmed.includes("$$") ? mermaidMathResolver(palette["--pele-fg"] ?? "#000000") : undefined;
    const out = render(trimmed, { links: false, images: false, autoDirection: false, ...(math ? { math } : {}) });
    const svg = resolveSvgVariables(typeof out === "string" ? out : String(out.svg ?? out), palette);
    const size = svgSize(svg);
    if (!size) throw new Error("The diagram could not be rendered.");
    result = { ok: true, url: `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`, ...size };
  } catch (cause) {
    result = { ok: false, message: cause instanceof Error ? cause.message : "The diagram could not be rendered." };
  }
  if (cache.size > 200) cache.clear();
  cache.set(key, result);
  return result;
}
