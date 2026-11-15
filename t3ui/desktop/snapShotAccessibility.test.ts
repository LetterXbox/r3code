import { expect, test } from "nsh/test";
import { capturedImageBounds, compactAccessibilityTree, normalizeAxRole, pngSize, resizeSnapShotAccessibility, snapShotAccessibilityFromRaw } from "./snapShotAccessibility";
import { snapShotWireSource } from "./snapShotSource";

const raw = {
  role: "AXWindow", name: "Notes", bounds: { x: 100, y: 50, width: 400, height: 300 },
  children: [
    { role: "AXGroup", bounds: { x: 100, y: 50, width: 400, height: 300 }, children: [
      { role: "AXButton", name: "Add", bounds: { x: 110, y: 60, width: 40, height: 20 }, enabled: false, children: [] },
    ] },
    { role: "AXStaticText", value: "Shopping list", bounds: { x: 200, y: 100, width: 100, height: 20 }, focused: true, children: [] },
  ],
};

test("the probe's raw tree maps to the captured image's pixels and anonymous groups fold away", () => {
  const read = snapShotAccessibilityFromRaw(raw, { x: 100, y: 50, width: 400, height: 300 }, { width: 800, height: 600 }, false, 20_000)!;
  expect(read.accessibility?.format).toBe("element-tree");
  const root = (read.accessibility as { root: { role: string; bounds: unknown; children: { role: string; name?: string; bounds: unknown; state?: unknown }[] } }).root;
  expect(root.role).toBe("window");
  expect(root.bounds).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  expect(root.children.map((c) => c.role)).toEqual(["button", "static_text"]);
  expect(root.children[0]!.bounds).toEqual({ x: 20, y: 20, width: 80, height: 40 });
  expect(root.children[0]!.state).toEqual({ enabled: false });
  expect(read.accessibleText).toBe("Notes\nAdd\nShopping list");
});

test("helpers follow the reference", () => {
  expect(normalizeAxRole("AXStaticText")).toBe("static_text");
  expect(capturedImageBounds({ x: 0, y: 0, width: 10, height: 10 }, { x: 100, y: 100, width: 10, height: 10 }, { width: 10, height: 10 })).toBe(null);
  const big = { role: "window", bounds: null, children: Array.from({ length: 2_000 }, (_, i) => ({ role: "button", name: `Button number ${i}`, bounds: null, children: [] })) };
  expect(compactAccessibilityTree(big).truncated).toBe(true);
  const tree = { format: "element-tree" as const, coordinateSpace: "captured-image" as const, imageSize: { width: 800, height: 600 }, truncated: false, root: { role: "window", bounds: { x: 0, y: 0, width: 800, height: 600 }, children: [] } };
  expect((resizeSnapShotAccessibility(tree, { width: 400, height: 300 }) as typeof tree).root.bounds).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  const png = new Uint8Array(24); png.set([0x89, 0x50, 0x4e, 0x47], 0); png.set([0, 0, 3, 32, 0, 0, 2, 88], 16);
  expect(pngSize(png)).toEqual({ width: 800, height: 600 });
});

test("the wire source carries the tree, or only flat text, or no accessibility when the setting is off", () => {
  const source = { appName: "Notes", windowTitle: "Shopping list", rawTree: raw, windowFrame: { x: 100, y: 50, width: 400, height: 300 } };
  const wire = snapShotWireSource({ ...source }, "2026-11-13T00:00:00.000Z", { width: 800, height: 600 }, true);
  expect(wire.kind).toBe("snap-shot");
  expect((wire.accessibility as { format: string }).format).toBe("element-tree");
  const flat = snapShotWireSource({ appName: "Notes", windowTitle: "", accessibleText: "Hello" }, "2026-11-13T00:00:00.000Z", null, true);
  expect(flat.accessibility).toEqual({ format: "flat-text", text: "Hello", truncated: false });
  const off = snapShotWireSource({ ...source }, "2026-11-13T00:00:00.000Z", { width: 800, height: 600 }, false);
  expect(off.accessibility).toBe(undefined);
  expect(off.accessibleText).toBe(undefined);
});
