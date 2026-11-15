import { expect, test } from "nsh/test";
import { pelePalette, renderMermaid, resolveSvgVariables, svgSize } from "./mermaid";

const colors: Record<string, string> = { background: "#111111", foreground: "#ffffff", "muted-foreground": "#999999", secondary: "#222222", accent: "#333333", primary: "#3366ff", destructive: "#ff0000" };
const palette = pelePalette((name) => colors[name], () => "#555555");

test("the palette follows the theme tokens the web app maps to --pele-*", () => {
  expect(palette["--pele-bg"]).toBe("#111111");
  expect(palette["--pele-surface"]).toBe("#222222");
  expect(palette["--pele-accent"]).toBe("#3366ff");
});

test("variables resolve through the svg's own declarations and the palette, and none are left", () => {
  const svg = '<svg width="10" height="20" style="--_s:var(--pele-surface,#f3f3f3);--_r:var(--pele-radius,4px)" fill="var(--_s)"><rect fill="var(--_s)" stroke="var(--pele-missing,#abcdef)" style="rx:var(--_r)"/></svg>';
  const out = resolveSvgVariables(svg, palette);
  expect(out).toContain('fill="#222222"');
  expect(out).toContain('stroke="#abcdef"');
  expect(out).toContain('rx="4px"');
  expect(out.includes("var(")).toBe(false);
  expect(out.includes("--")).toBe(false);
  expect(svgSize(out)).toEqual({ width: 10, height: 20 });
});

test("a flowchart renders to an svg data url coloured by the palette; garbage reports why it did not", () => {
  const result = renderMermaid("flowchart LR\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]", palette);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const svg = decodeURIComponent(escape(atob(result.url.split(",")[1])));
    expect(svg.includes("var(")).toBe(false);
    expect(svg).toContain("#222222");
    expect(result.width).toBeGreaterThan(0);
  }
  const bad = renderMermaid("not a diagram at all", palette);
  expect(bad.ok).toBe(false);
});

test("$$ labels inside a diagram are typeset (MermaidDiagram loadMath); unreadable TeX keeps its source", async () => {
  const { renderMermaid: draw } = await import("./mermaid");
  const decode = (url: string) => decodeURIComponent(escape(atob(url.split(",")[1]!)));
  const typeset = draw("flowchart LR\n  A[\"$$x^2 + 1$$\"] --> B[plain]", { "--pele-fg": "#111111" });
  expect(typeset.ok).toBe(true);
  const svg = typeset.ok ? decode(typeset.url) : "";
  expect(svg.includes("pele-math")).toBe(true);
  expect(svg.includes("$$")).toBe(false);
  expect(svg.includes("#111111")).toBe(true);
  const broken = draw("flowchart LR\n  A[\"$$\\\\frac{$$\"] --> B", { "--pele-fg": "#111111" });
  expect(broken.ok && decode(broken.url).includes("pele-math")).toBe(false);
});
