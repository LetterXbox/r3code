import { expect, test } from "nsh/test";
import { exToPoints, mathSource, prepareMathSvg, renderMath } from "./math";

test("a formula typesets to a sized image in the given colour", () => {
  const result = renderMath("\\frac{a}{b}+\\sqrt{x^2}", false, 16, "#ff0000");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.url.startsWith("data:image/svg+xml;base64,")).toBe(true);
  const svg = decodeURIComponent(escape(atob(result.url.split(",")[1])));
  expect(svg).toContain('fill="#ff0000"');
  expect(svg.includes("currentColor")).toBe(false);
  expect(svg.includes("ex\"")).toBe(false);
  expect(result.width).toBeGreaterThan(20);
  expect(result.height).toBeGreaterThan(10);
  expect(result.depth).toBeGreaterThan(0);
});

test("display and inline forms both typeset, and a block is no narrower than its inline text", () => {
  const inline = renderMath("\\sum_{i=1}^{n} i", false, 16, "#fff");
  const block = renderMath("\\sum_{i=1}^{n} i", true, 16, "#fff");
  expect(inline.ok && block.ok).toBe(true);
});

test("TeX MathJax cannot read keeps its source in the web app's delimiters", () => {
  const broken = renderMath("\\frac{", true, 16, "#fff");
  expect(broken).toEqual({ ok: false, source: "\\[\n\\frac{\n\\]" });
  expect(renderMath("\\frac{", false, 16, "#fff")).toEqual({ ok: false, source: "\\(\\frac{\\)" });
  expect(mathSource("  x  ", false)).toBe("\\(x\\)");
});

test("ex units convert at half the font size and the baseline shift becomes the depth", () => {
  expect(exToPoints(4, 16)).toBe(32);
  const out = prepareMathSvg('<svg style="vertical-align: -0.5ex;" width="2ex" height="3ex"><path fill="currentColor"/></svg>', 10, "#123456");
  expect(out?.width).toBe(10);
  expect(out?.height).toBe(15);
  expect(out?.depth).toBe(2.5);
  expect(out?.svg).toContain('fill="#123456"');
});
