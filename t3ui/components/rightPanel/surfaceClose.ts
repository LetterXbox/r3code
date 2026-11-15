// useRightPanelSurfaceClose.ts: closing a panel tab releases what it held. A terminal tab closes its terminal sessions
// (history deleted, after the destructive confirmation when one tab is closed on its own), a side chat that never ran is
// deleted (thread.delete onlyIfUnused: the server keeps one with a run or a message), and a server browser tab closes its
// preview session. Each needs its scope (terminal / orchestration / preview operate). The panel change itself is one
// state update, so the reference's "active surface closes last" ordering has no flash to avoid here.
import { panelTerminalLabel, type PanelState, type Surface } from "./panelLogic";
import { beginServerTabClose, cancelServerTabClose } from "./serverPreviewSessions";
import { closeNativeTab } from "./desktopPreviewSessions";

export interface SurfaceCloseDeps {
  rpc: (method: string, payload: unknown) => Promise<unknown>;
  canOperateTerminal: () => boolean;
  canOperateThread: () => boolean;
  canOperatePreview: () => boolean;
  confirmTerminalClose: (labels: readonly [string, ...string[]]) => Promise<boolean>;
}

export function removedSurfaces(before: PanelState, after: PanelState): Surface[] {
  const kept = new Set(after.surfaces.map((surface) => surface.id));
  return before.surfaces.filter((surface) => !kept.has(surface.id));
}

export function releaseSurfaces(threadId: string, removed: readonly Surface[], deps: SurfaceCloseDeps): void {
  for (const surface of removed) {
    if (surface.kind === "terminal" && deps.canOperateTerminal()) {
      // closeTerminalSession (useThreadTerminalActions): a failed close falls back to typing `exit` while the session may still operate.
      for (const terminalId of surface.terminalIds ?? []) {
        void deps.rpc("terminal.close", { threadId, terminalId, deleteHistory: true }).catch(() => {
          if (deps.canOperateTerminal()) return deps.rpc("terminal.write", { threadId, terminalId, data: "exit\n" }).catch(() => {});
          return undefined;
        });
      }
    }
    if (surface.kind === "side-chat" && surface.threadId && deps.canOperateThread()) {
      void deps.rpc("orchestration.dispatchCommand", { type: "thread.delete", commandId: `command:${crypto.randomUUID()}`, threadId: surface.threadId, onlyIfUnused: true }).catch(() => {});
    }
    if (surface.kind === "preview" && !surface.serverTabId) closeNativeTab(`${threadId}\u0000${surface.id}`);
    if (surface.kind === "preview" && surface.serverTabId && deps.canOperatePreview()) {
      const tabId = surface.serverTabId;
      beginServerTabClose(threadId, tabId);
      void deps.rpc("preview.close", { threadId, tabId }).catch(() => cancelServerTabClose(threadId, tabId));
    }
  }
}

/** Applies `change` and releases the tabs it closed. `single` is the tab menu's Close / a tab's own close: a terminal tab
 * closed on its own asks first, naming its active terminal and then the others. */
export function closeSurfacesAndRelease(input: { threadId: string | null; state: () => PanelState; apply: (change: (state: PanelState) => PanelState) => void; change: (state: PanelState) => PanelState; single?: Surface | undefined; deps: SurfaceCloseDeps }): Promise<void> {
  const finish = () => {
    const before = input.state();
    input.apply(input.change);
    if (input.threadId) releaseSurfaces(input.threadId, removedSurfaces(before, input.state()), input.deps);
  };
  const single = input.single;
  const ids = single?.kind === "terminal" ? single.terminalIds ?? [] : [];
  const active = single?.activeTerminalId ?? ids[0];
  // Anything but a terminal tab closes at once (same tick); a terminal tab waits for its confirmation.
  if (single?.kind !== "terminal" || !input.deps.canOperateTerminal() || !active) { finish(); return Promise.resolve(); }
  const labels = [panelTerminalLabel(active), ...ids.filter((id) => id !== active).map(panelTerminalLabel)] as [string, ...string[]];
  return input.deps.confirmTerminalClose(labels).then((confirmed) => { if (confirmed) finish(); });
}

// rightPanel.close (mod+w) closes the active tab through the same path (useRightPanelActions -> closeRightPanelSurface).
// The panel registers the live dependencies when it mounts; without a panel the close only edits the state.
let registeredDeps: SurfaceCloseDeps | null = null;
export function setSurfaceCloseDeps(deps: SurfaceCloseDeps | null) { registeredDeps = deps; }
export const surfaceCloseDeps = () => registeredDeps;
