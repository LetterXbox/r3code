import { expect, test } from "nsh/test";
import { closeAllSurfaces, closeSurface, initialPanelState, type PanelState } from "./panelLogic";
import { closeSurfacesAndRelease, type SurfaceCloseDeps } from "./surfaceClose";

const panel = (): PanelState => ({
  ...initialPanelState,
  open: true,
  activeId: "terminal:term-1",
  surfaces: [
    { id: "terminal:term-1", kind: "terminal", terminalIds: ["term-1", "term-2"], activeTerminalId: "term-2" },
    { id: "side-chat:sc1", kind: "side-chat", threadId: "sc1" },
    { id: "server-preview:tab_1", kind: "preview", serverTabId: "tab_1", previewUrl: "https://x/" },
    { id: "browser:1", kind: "preview", previewUrl: "http://localhost:3000/" },
  ],
} as PanelState);

function harness(answer = true) {
  let state = panel();
  const calls: [string, any][] = [];
  const asked: string[][] = [];
  const deps: SurfaceCloseDeps = {
    rpc: async (method, payload) => { calls.push([method, payload]); return null; },
    canOperateTerminal: () => true, canOperateThread: () => true, canOperatePreview: () => true,
    confirmTerminalClose: async (labels) => { asked.push([...labels]); return answer; },
  };
  const run = (change: (s: PanelState) => PanelState, single?: any) => closeSurfacesAndRelease({ threadId: "t1", state: () => state, apply: (c) => { state = c(state); }, change, single, deps });
  return { run, calls, asked, state: () => state };
}

test("fm13: closing a terminal tab asks (active terminal first), then closes every terminal session of the tab", async () => {
  const h = harness();
  const tab = panel().surfaces[0]!;
  await h.run((s) => closeSurface(s, tab.id), tab);
  expect(h.asked).toEqual([["Terminal 2", "Terminal 1"]]);
  expect(h.calls).toEqual([["terminal.close", { threadId: "t1", terminalId: "term-1", deleteHistory: true }], ["terminal.close", { threadId: "t1", terminalId: "term-2", deleteHistory: true }]]);
  expect(h.state().surfaces.some((s) => s.id === tab.id)).toBe(false);
});

test("fm13: declining keeps the terminal tab and its sessions", async () => {
  const h = harness(false);
  const tab = panel().surfaces[0]!;
  await h.run((s) => closeSurface(s, tab.id), tab);
  expect(h.calls).toEqual([]);
  expect(h.state().surfaces.length).toBe(4);
});

test("fm13: Close all deletes an unused side chat and closes the server browser session; a local tab has none", async () => {
  const h = harness();
  await h.run(closeAllSurfaces);
  const methods = h.calls.map(([m, p]) => `${m}:${p.type ?? p.tabId ?? p.terminalId}`);
  expect(methods).toEqual(["terminal.close:term-1", "terminal.close:term-2", "orchestration.dispatchCommand:thread.delete", "preview.close:tab_1"]);
  expect(h.calls[2]![1]).toMatchObject({ type: "thread.delete", threadId: "sc1", onlyIfUnused: true });
  expect(h.asked).toEqual([]);
});

test("a failed terminal close falls back to typing exit, unless the session may not operate", async () => {
  for (const operate of [true, false]) {
    const calls: [string, any][] = [];
    const deps: SurfaceCloseDeps = {
      rpc: async (method, payload) => { calls.push([method, payload]); if (method === "terminal.close") throw new Error("refused"); return null; },
      canOperateTerminal: () => operate, canOperateThread: () => true, canOperatePreview: () => true,
      confirmTerminalClose: async () => true,
    };
    let state = panel();
    const tab = state.surfaces[0]!;
    await closeSurfacesAndRelease({ threadId: "t1", state: () => state, apply: (c) => { state = c(state); }, change: (s) => closeSurface(s, tab.id), single: undefined, deps });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const writes = calls.filter(([method]) => method === "terminal.write").map(([, payload]) => payload);
    expect(writes).toEqual(operate ? [{ threadId: "t1", terminalId: "term-1", data: "exit\n" }, { threadId: "t1", terminalId: "term-2", data: "exit\n" }] : []);
  }
});
