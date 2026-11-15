import { expect, test } from "nsh/test";
import { applyPendingMaximize, consumePanelMaximizeRequest, overridePanelContext, panelStateFor, requestPanelMaximize, updatePanel } from "./panelState";

test("a maximize request is consumed once, by its own panel, when it has a tab (requestMaximize / consumeMaximizeRequest)", () => {
  requestPanelMaximize("k1");
  expect(consumePanelMaximizeRequest("k2")).toBe(false);
  expect(consumePanelMaximizeRequest("k1")).toBe(true);
  expect(consumePanelMaximizeRequest("k1")).toBe(false);
  overridePanelContext({ key: "k3", workspace: null });
  requestPanelMaximize("k3");
  expect(applyPendingMaximize()).toBe(false);
  updatePanel("k3", (state) => ({ ...state, surfaces: [{ id: "s1", kind: "preview" } as never], activeId: "s1" }));
  expect(applyPendingMaximize()).toBe(true);
  expect(panelStateFor("k3").maximized).toBe(true);
  expect(applyPendingMaximize()).toBe(false);
  overridePanelContext(null);
});

test("reconcileFileSurfaces drops Files and file tabs but keeps attachments when the workspace is gone", async () => {
  const { reconcileFileSurfaces, initialPanelState } = await import("./panelLogic");
  const state = { ...initialPanelState, open: true, activeId: "f1", surfaces: [{ id: "files", kind: "files" }, { id: "f1", kind: "file", relativePath: "a.ts" }, { id: "att", kind: "file", relativePath: "x.png", attachment: { id: "1" } }, { id: "p", kind: "preview" }] as never };
  expect(reconcileFileSurfaces(state, true)).toBe(state);
  const next = reconcileFileSurfaces(state, false);
  expect(next.surfaces.map((s) => s.id)).toEqual(["att", "p"]);
  expect(next.activeId).toBe("p");
  const empty = reconcileFileSurfaces({ ...initialPanelState, open: true, activeId: "files", surfaces: [{ id: "files", kind: "files" }] as never }, false);
  expect(empty.open).toBe(false);
  expect(empty.activeId).toBe(null);
});
