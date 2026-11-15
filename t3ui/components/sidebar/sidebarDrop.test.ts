import { expect, test } from "nsh/test";
import { insertionIndex, resolveSidebarDropVerb, sectionAtY } from "./sidebarDrop";

test("dropping on Pinned pins, whatever the row was", () => {
  expect(resolveSidebarDropVerb("active", "pinned")).toBe("pin");
  expect(resolveSidebarDropVerb("settled", "pinned")).toBe("pin");
  expect(resolveSidebarDropVerb("snoozed", "pinned")).toBe("pin");
});

test("dropping on Settled settles", () => {
  expect(resolveSidebarDropVerb("active", "settled")).toBe("settle");
  expect(resolveSidebarDropVerb("pinned", "settled")).toBe("settle");
});

test("dropping on Active undoes where the row came from", () => {
  expect(resolveSidebarDropVerb("pinned", "active")).toBe("unpin");
  expect(resolveSidebarDropVerb("settled", "active")).toBe("unsettle");
  expect(resolveSidebarDropVerb("snoozed", "active")).toBe("wake");
});

test("dropping where it already is, on Snoozed, or nowhere does nothing", () => {
  expect(resolveSidebarDropVerb("pinned", "pinned")).toBe(null);
  expect(resolveSidebarDropVerb("active", "active")).toBe(null);
  expect(resolveSidebarDropVerb("active", "snoozed")).toBe(null);
  expect(resolveSidebarDropVerb("active", null)).toBe(null);
});

test("a point finds the zone that holds it", () => {
  const zones = [
    { section: "pinned" as const, top: 0, bottom: 100 },
    { section: "active" as const, top: 100, bottom: 300 },
    { section: "settled" as const, top: 320, bottom: 400 },
  ];
  expect(sectionAtY(zones, 50)).toBe("pinned");
  expect(sectionAtY(zones, 100)).toBe("active");
  expect(sectionAtY(zones, 310)).toBe(null);
  expect(sectionAtY(zones, 399)).toBe("settled");
  expect(sectionAtY(zones, 400)).toBe(null);
});

test("a drop takes the slot below every row centre it is past", () => {
  expect(insertionIndex([40, 100, 160], 10)).toBe(0);
  expect(insertionIndex([40, 100, 160], 100)).toBe(1);
  expect(insertionIndex([40, 100, 160], 130)).toBe(2);
  expect(insertionIndex([40, 100, 160], 400)).toBe(3);
  expect(insertionIndex([], 50)).toBe(0);
});
