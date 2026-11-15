import { expect, test } from "nsh/test";
import { completeSidebarRouteReveal, nearestScrollOffset, pendingSidebarRouteReveal, routeRevealWidensScope } from "./routeReveal";

test("a route change owes one reveal; null keys are ignored", () => {
  const reveal = { observedKey: null, pendingKey: null };
  expect(pendingSidebarRouteReveal(reveal, "a")).toBe("a");
  completeSidebarRouteReveal(reveal);
  expect(pendingSidebarRouteReveal(reveal, null)).toBe(null);
  expect(pendingSidebarRouteReveal(reveal, "a")).toBe(null);
  expect(pendingSidebarRouteReveal(reveal, "b")).toBe("b");
});

test("a route reveal widens a scope that hides the thread, but not while searching", () => {
  expect(routeRevealWidensScope({ pendingKey: "t", isSearching: false, scopeIds: ["p1"], threadProjectId: "p2" })).toBe(true);
  expect(routeRevealWidensScope({ pendingKey: "t", isSearching: true, scopeIds: ["p1"], threadProjectId: "p2" })).toBe(false);
  expect(routeRevealWidensScope({ pendingKey: "t", isSearching: false, scopeIds: ["p2"], threadProjectId: "p2" })).toBe(false);
  expect(routeRevealWidensScope({ pendingKey: "t", isSearching: false, scopeIds: [], threadProjectId: "p2" })).toBe(false);
  expect(routeRevealWidensScope({ pendingKey: null, isSearching: false, scopeIds: ["p1"], threadProjectId: "p2" })).toBe(false);
});

test("nearest scroll offset", () => {
  expect(nearestScrollOffset({ offset: 100, viewport: 400, rowTop: 50, rowHeight: 30 })).toBe(null);
  expect(nearestScrollOffset({ offset: 100, viewport: 400, rowTop: -40, rowHeight: 30 })).toBe(60);
  expect(nearestScrollOffset({ offset: 100, viewport: 400, rowTop: 500, rowHeight: 30 })).toBe(230);
});

test("a thread shown under its parent never widens the scope", () => {
  expect(routeRevealWidensScope({ pendingKey: "t", isSearching: false, scopeIds: ["p1"], threadProjectId: "p2", listedWithoutScope: false })).toBe(false);
  expect(routeRevealWidensScope({ pendingKey: "t", isSearching: false, scopeIds: ["p1"], threadProjectId: "p2", listedWithoutScope: true })).toBe(true);
});
