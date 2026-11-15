import { expect, test } from "nsh/test";
import { THEME_CARDS } from "../../themePreviews";
import { hexAlpha, mixThemePreviewBase, sphereSpec, THEME_PREVIEW_RENDER_SPECS, wireframePanes, wireframeShapes, WIREFRAME_LINE } from "./themeArtData";

const ocean = THEME_CARDS.find((card) => card.id === "ocean")!;
const colorsOf = (mode: "light" | "dark") => ocean.previews.find((p) => p.mode === mode)!.colors;
const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

test("Ocean's wireframe is drawn in its own colours, accent dot included", () => {
  for (const mode of ["light", "dark"] as const) {
    const colors = colorsOf(mode);
    const shapes = wireframeShapes(colors);
    expect(shapes[0]).toEqual({ kind: "rect", x: 0, y: 0, w: 1, h: 1, radius: 0, fill: colors.canvas });
    expect(shapes[1]).toEqual({ kind: "rect", x: 0, y: 0, w: 0.22, h: 1, radius: 0, fill: colors.sidebar });
    const dots = shapes.filter((s) => s.kind === "circle");
    // composer action in messageAction, then the details card's three rows (green, messageAction, amber)
    expect(dots.map((s) => s.fill)).toEqual([colors.messageAction, "#34d399", colors.messageAction, "#fbbf24"]);
    expect(shapes.some((s) => s.kind === "rect" && s.fill === WIREFRAME_LINE)).toBe(true);
    expect(shapes.some((s) => s.kind === "rect" && s.shadow === true)).toBe(true);
  }
  expect(colorsOf("light").messageAction).toBe("#0a6f75");
  expect(colorsOf("dark").messageAction).toBe("#5bd0d6");
});

test("System keeps the light pane's left half and the dark pane's right half", () => {
  expect(wireframePanes("system")).toEqual([{ appearance: "light", clip: "left" }, { appearance: "dark", clip: "right" }]);
  expect(wireframePanes("light")).toEqual([{ appearance: "light", clip: null }]);
  expect(wireframePanes("dark")).toEqual([{ appearance: "dark", clip: null }]);
});

test("the sphere is the reference's two radial gradients over the mixed base", () => {
  const dark = sphereSpec(colorsOf("dark"), "dark");
  const spec = THEME_PREVIEW_RENDER_SPECS.dark;
  expect(dark.scale).toBe(1.1);
  expect(dark.gradients.map((g) => g.center)).toEqual([spec.action.center, spec.accent.center]);
  const accent = dark.gradients[1]!;
  expect(accent.stops.map((s) => s.offset)).toEqual([0, 0.28, 0.58]);
  expect(accent.stops[0]!.color).toBe("#70b9ee");
  expect(accent.stops[1]!.color).toBe(hexAlpha("#70b9ee", 0.62));
  expect(accent.stops[2]!.color).toBe("rgba(112,185,238,0)");
  // circle sizing is the farthest corner: from (0.28, 0.78) that is the top-right corner
  expect(Math.abs(accent.radius - Math.hypot(0.72, 0.78)) < 1e-9).toBe(true);
  const action = dark.gradients[0]!;
  expect(action.stops[0]!.color).toBe(hexAlpha("#5bd0d6", 0.45));
  expect(action.stops[1]!.offset).toBe(0.55);
});

test("the base is the canvas mixed 80/20 toward the mode's target", () => {
  const dark = channels(mixThemePreviewBase(colorsOf("dark").canvas, "dark"));
  const darkCanvas = channels(colorsOf("dark").canvas);
  for (let i = 0; i < 3; i++) expect(dark[i]! <= darkCanvas[i]!).toBe(true);
  const light = channels(mixThemePreviewBase(colorsOf("light").canvas, "light"));
  const lightCanvas = channels(colorsOf("light").canvas);
  for (let i = 0; i < 3; i++) expect(light[i]! >= lightCanvas[i]!).toBe(true);
  expect(sphereSpec(colorsOf("light"), "light").edge).toBe("rgba(0,0,0,0.10)");
  expect(sphereSpec(colorsOf("dark"), "dark").edge).toBe("rgba(255,255,255,0.14)");
});
