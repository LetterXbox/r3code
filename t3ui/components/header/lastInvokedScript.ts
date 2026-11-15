// useChatTerminalActions lastInvokedScriptByProjectId (localStorage "t3code:last-invoked-script-by-project"): the
// script last run in each project becomes the header's primary script button.
import { signal, Storage } from "nsh";

const STORAGE_KEY = "t3code:last-invoked-script-by-project";
const byProject = signal<Record<string, string>>({});
let hydrated = false;

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  void Storage.getItem(STORAGE_KEY).then((raw) => {
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") byProject.set({ ...Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string")), ...byProject() } as Record<string, string>);
    } catch { /* A corrupt entry is dropped. */ }
  }).catch(() => {});
}

export function lastInvokedScriptId(projectId: string | null | undefined): string | null {
  hydrate();
  return projectId ? byProject()[projectId] ?? null : null;
}

export function rememberInvokedScript(projectId: string, scriptId: string): void {
  hydrate();
  if (byProject()[projectId] === scriptId) return;
  byProject.update((all) => ({ ...all, [projectId]: scriptId }));
  void Storage.setItem(STORAGE_KEY, JSON.stringify(byProject())).catch(() => {});
}
