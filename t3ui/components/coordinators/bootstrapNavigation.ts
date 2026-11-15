// EventRouter's welcome handling (apps/web/src/routes/__root.tsx): on a server welcome that names a bootstrap
// project and thread, expand that project, and open the thread once when the app is on its root view (here: the
// thread view, with neither Settings nor a utility page over it).
import { effect, untracked } from "nsh";
import { isCollapsed, openThreadById, settingsOpen, toggleProject, usageOpen, utilityPage } from "../../store";
import { serverWelcome, type ServerWelcome } from "./serverStreams";

let handledThreadId: string | null = null;

/** Test hook. */
export function resetBootstrapNavigation() { handledThreadId = null; }

export function handleBootstrapWelcome(payload: ServerWelcome | null, view: { onRoot: boolean }): "opened" | "expanded" | null {
  if (!payload?.bootstrapProjectId || !payload.bootstrapThreadId) return null;
  if (isCollapsed(payload.bootstrapProjectId)) toggleProject(payload.bootstrapProjectId);
  if (!view.onRoot || handledThreadId === payload.bootstrapThreadId) return "expanded";
  openThreadById(payload.bootstrapThreadId);
  handledThreadId = payload.bootstrapThreadId;
  return "opened";
}

let installed = false;
export function installBootstrapNavigation() {
  if (installed) return;
  installed = true;
  effect(() => {
    const welcome = serverWelcome();
    untracked(() => handleBootstrapWelcome(welcome, { onRoot: !settingsOpen() && !usageOpen() && utilityPage() === null }));
  });
}
