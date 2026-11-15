import { expect, test } from "nsh/test";
import { initialPanelState, openDevicePlaceholder, openDeviceSurface, readPanelState, renameDeviceSurface, surfaceTitle } from "./panelLogic";

const target = { hostId: "local", deviceId: "S 1", platform: "ios" as const, name: "iPhone 15" };

test("the placeholder tab becomes the device's own tab, and reopening a device shows its tab", () => {
  const placeholder = openDevicePlaceholder(initialPanelState);
  expect(placeholder.surfaces.map((s) => s.id)).toEqual(["device"]);
  const opened = openDeviceSurface(placeholder, target);
  expect(opened.surfaces.map((s) => s.id)).toEqual(["device:local:S%201"]);
  expect(opened.activeId).toBe("device:local:S%201");
  const again = openDeviceSurface(openDevicePlaceholder(opened), target);
  expect(again.surfaces.map((s) => s.id)).toEqual(["device:local:S%201"]);
});

test("a device tab is titled by its name until renamed; an empty name goes back", () => {
  const opened = openDeviceSurface(initialPanelState, target);
  const id = opened.activeId!;
  expect(surfaceTitle(opened.surfaces[0]!)).toBe("iPhone 15");
  const renamed = renameDeviceSurface(opened, id, "  Checkout flow ");
  expect(surfaceTitle(renamed.surfaces[0]!)).toBe("Checkout flow");
  expect(surfaceTitle(renameDeviceSurface(renamed, id, "  ").surfaces[0]!)).toBe("iPhone 15");
  expect(surfaceTitle({ id: "device", kind: "device" })).toBe("Device");
});

test("device tabs survive a restart", () => {
  const renamed = renameDeviceSurface(openDeviceSurface(initialPanelState, target), "device:local:S%201", "QA");
  const read = readPanelState(JSON.parse(JSON.stringify(renamed)));
  expect(read.surfaces[0]).toMatchObject({ kind: "device", title: "QA", target });
});
