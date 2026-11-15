import { expect, test } from "nsh/test";
import { clampThemeEditorAnchor, resizeThemeEditor } from "./themeEditorPosition";

test("the theme editor anchor keeps the panel within the window", () => {
  const window = { width: 1000, height: 800 };
  const panel = { width: 416, height: 672 };
  expect(clampThemeEditorAnchor({ x: -100, y: 2000 }, window, panel)).toEqual({ x: 424, y: 792 });
  expect(clampThemeEditorAnchor({ x: 700, y: 720 }, window, panel)).toEqual({ x: 700, y: 720 });
});

test("resizing preserves the top-left and respects minimum and window edges", () => {
  const input = { origin: { x: 100, y: 100 }, size: { width: 416, height: 500 }, window: { width: 1000, height: 800 } };
  expect(resizeThemeEditor({ ...input, delta: { x: -500, y: -500 } })).toEqual({ anchor: { x: 380, y: 320 }, size: { width: 280, height: 220 } });
  expect(resizeThemeEditor({ ...input, delta: { x: 1000, y: 1000 } })).toEqual({ anchor: { x: 992, y: 792 }, size: { width: 892, height: 692 } });
});
