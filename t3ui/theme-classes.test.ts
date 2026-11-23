// Keeps unknown theme classes from creeping in. NSH silently drops a class it cannot resolve, so the
// element renders unstyled; the build only prints a warning. This scans the app's TSX/TS sources for
// colour/token classes and fails on any that theme.json (plus NSH's built-in scales and nsh.json's
// tailwind extensions) cannot resolve, and on any alpha modifier over a theme token (NSH squares
// those; use the flattened `token-NN` instead).
import { expect, test } from "nsh/test";
import theme from "./theme.json";
import nshConfig from "./nsh.json";
// `nsh test` cannot read the source tree, so tools/scan_theme_classes.py snapshots every utility
// class of the app's sources into this file ({"<file>::<class>": line}). Re-run it after editing
// components: `python3 tools/scan_theme_classes.py`, then this test.
import usage from "./theme-class-usage.json";

const cssVars = (theme as { cssVars: { light: Record<string, string>; dark: Record<string, string> } }).cssVars;
const tokens = new Set([...Object.keys(cssVars.light), ...Object.keys(cssVars.dark)]);
const fontSizes = new Set(Object.keys((nshConfig as { tailwind?: { fontSize?: Record<string, number> } }).tailwind?.fontSize ?? {}));

// Classes that cannot be fixed through the theme and need a component edit (owner: file in the key's
// comment). Key is `<file relative to t3ui>::<class>`. Remove an entry when its component is fixed;
// the test also fails on a stale entry so this list cannot rot.
export const NEEDS_COMPONENT_EDIT: Record<string, string> = {
  "components/rightPanel/RightPanel.tsx::bg-background/88": "rightPanel: deliberate. A backdrop over live content has no fixed base to flatten against, so the alpha is compensated instead: NSH squares 0.88 to the reference's 0.77",
};

// Strings that look like classes but are identifiers (icon names, panel ids, keys).
const NOT_CLASSES = new Set(["text-search", "text-generation", "text-generation-model", "text-generators",
  // OpenDocument XML names read by components/files/officeDocs.ts.
  "style:text-properties", "style:text-underline-style", "style:text-line-through-style", "text:outline-level"]);

const PALETTE = /^(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}$/;
const TEXT_SIZES = new Set(["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl"]);
const TEXT_MISC = new Set(["left", "right", "center", "justify", "start", "end", "wrap", "nowrap", "balance", "pretty", "ellipsis", "clip"]);
const BG_MISC = /^(auto|cover|contain|center|top|bottom|left|right|no-repeat|repeat|fixed|local|scroll|none|gradient-.*|linear-.*|clip-.*|origin-.*|blend-.*)$/;
const LINE_STYLES = new Set(["solid", "dashed", "dotted", "double", "hidden", "none", "collapse", "separate", "spacing"]);
const BUILTIN_COLORS = new Set(["white", "black", "transparent", "current", "inherit"]);
const PREFIX = /^(bg|text|border(?:-[tblrxyse])?|ring|ring-offset|fill|stroke|divide|outline|placeholder)-(.+)$/;

/** Splits a class on `:` variants outside brackets. */
function splitVariants(cls: string): { variants: string[]; base: string } {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of cls) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === ":" && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  return { variants: parts, base: cur };
}

/** Why `cls` cannot resolve against the theme, or null when it can (or is not a token class). */
export function problemWith(cls: string): string | null {
  let { base } = splitVariants(cls);
  base = base.replace(/^[!-]+/, "");
  // Sizing utilities NSH warns about (not colours, but the build drops them the same way).
  if (/^(min-|max-)?[wh]-\[.*calc\(/.test(base)) return "calc() arbitrary value NSH cannot resolve";
  if (base === "min-w-max" || base === "max-w-max") return "max-content sizing NSH does not know";
  const m = PREFIX.exec(base);
  if (!m) return null;
  const [, prefix, rest] = m;
  if (rest.startsWith("[")) {
    return /calc\(|\d(em|rem|%|vw|vh)\]/.test(rest) && prefix === "text" && /em\]$/.test(rest)
      ? "relative-unit arbitrary size NSH cannot resolve"
      : /calc\(/.test(rest) ? "calc() arbitrary value NSH cannot resolve" : null;
  }
  let value = rest;
  let alpha: string | null = null;
  const slash = rest.lastIndexOf("/");
  if (slash > 0 && !rest.slice(slash).includes("]")) { value = rest.slice(0, slash); alpha = rest.slice(slash + 1); }
  if (BUILTIN_COLORS.has(value)) return null;
  if (PALETTE.test(value)) return null;
  if (tokens.has(value)) {
    if (alpha === null) return null;
    const flat = `${value}-${alpha}`;
    return tokens.has(flat)
      ? `alpha modifier is squared by NSH; use \`${prefix}-${flat}\``
      : `alpha modifier is squared by NSH and theme.json has no flattened \`${flat}\` token (add it to the generators)`;
  }
  const numeric = /^\d+(\.\d+)?$/.test(value);
  if (prefix === "text") {
    if (TEXT_SIZES.has(value) || fontSizes.has(value) || TEXT_MISC.has(value)) return null;
    return `unknown text size or colour \`${value}\``;
  }
  if (prefix.startsWith("border")) {
    if (numeric || LINE_STYLES.has(value) || /^(t|b|l|r|x|y|s|e)$/.test(value)) return null;
    return `unknown border colour \`${value}\``;
  }
  if (prefix === "bg") {
    if (BG_MISC.test(value)) return null;
    return `unknown background colour \`${value}\``;
  }
  if (numeric || /^(inset|x|y|x-\d+|y-\d+|reverse|none|hidden|dashed|dotted|solid|double|auto)$/.test(value)) return null;
  return `unknown ${prefix} colour \`${value}\``;
}

test("the generated theme still carries font-sans and the tokens the scanner relies on", () => {
  const base = (theme as { cssVars: { theme: Record<string, string> } }).cssVars.theme;
  expect(base["font-sans"].startsWith('"Bricolage Grotesque UI"')).toBe(true);
  expect(tokens.has("background")).toBe(true);
  expect(tokens.has("card-40")).toBe(true);
  expect(tokens.has("muted-50")).toBe(true);
  expect(fontSizes.has("3xs")).toBe(true);
});

test("problemWith classifies tokens, flattened alphas and unknowns", () => {
  expect(problemWith("bg-card")).toBe(null);
  expect(problemWith("hover:bg-sidebar-row-hover")).toBe(null);
  expect(problemWith("text-3xs")).toBe(null);
  expect(problemWith("text-[13px]")).toBe(null);
  expect(problemWith("border-l-2")).toBe(null);
  expect(problemWith("bg-black/80")).toBe(null);
  expect(problemWith("bg-card/40")).toContain("bg-card-40");
  expect(problemWith("border-border/60")).toContain("border-border-60");
  expect(problemWith("bg-error")).toBe(null);
  expect(problemWith("text-error-foreground")).toBe(null);
  expect(problemWith("bg-nonexistent")).toContain("unknown background");
  expect(problemWith("text-9xs")).toContain("unknown text");
  expect(problemWith("text-[0.85em]")).toContain("relative-unit");
  expect(problemWith("max-w-[calc(100%-1.5rem)]")).toContain("calc()");
  expect(problemWith("min-w-max")).toContain("max-content");
});

test("every colour/token class in the app sources resolves against the theme", () => {
  const failures: string[] = [];
  const used = new Set<string>();
  for (const [key, line] of Object.entries(usage as Record<string, number>)) {
    const [file, cls] = key.split("::");
    if (NOT_CLASSES.has(cls)) continue;
    const why = problemWith(cls);
    if (!why) continue;
    used.add(key);
    if (NEEDS_COMPONENT_EDIT[key]) continue;
    failures.push(`${file}:${line} ${cls} -> ${why}`);
  }
  const stale = Object.keys(NEEDS_COMPONENT_EDIT).filter((key) => !used.has(key));
  expect({ failures, stale }).toEqual({ failures: [], stale: [] });
});
