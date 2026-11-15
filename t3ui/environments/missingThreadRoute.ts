// ThreadRouteView.tsx: a server thread confirmed missing sends the route home, but only when its environment has any
// threads or drafts (environmentHasAnyThreads), so an environment still loading its shell keeps the route.
import { allThreads, closeOpenThread, setMissingThreadHook, setRemoteThreadProbe, sidebarDrafts } from "../store";
import { record } from "../backend/client";
import { loadSessionBearer } from "../backend/sessionCredential";
import { managedEnvironment } from "./connectionManager";
import { parseScopedKey, remoteShell } from "./connectionManager";
import { hasDraftThreadsInEnvironment } from "./environmentDrafts";

export function environmentHasAnyThreads(threadId: string): boolean {
  const environmentId = parseScopedKey(threadId)?.environmentId ?? null;
  if (environmentId) return (remoteShell(environmentId)?.threads.length ?? 0) > 0 || hasDraftThreadsInEnvironment(environmentId);
  return allThreads().some((thread) => !thread.environmentId && thread.id !== threadId) || sidebarDrafts().some((draft) => !parseScopedKey(draft.projectId ?? ""));
}

export function handleMissingThread(threadId: string): void {
  // The store calls this only while the thread is still the open one.
  if (environmentHasAnyThreads(threadId)) closeOpenThread();
}

/** boundedThreadSnapshotHttp.ts for a saved environment's thread: only whether the server says it is missing (404). */
export async function probeRemoteThread(id: string, fetcher: typeof fetch = (input, init) => fetch(input, init), bearerFor: (url: string) => Promise<string | null> = loadSessionBearer): Promise<"present" | "missing" | "unavailable"> {
  const parsed = parseScopedKey(id);
  const environment = parsed ? managedEnvironment(parsed.environmentId) : null;
  if (!parsed || !environment) return "unavailable";
  const bearer = await bearerFor(environment.url);
  if (!bearer) return "unavailable";
  const url = new URL(environment.url);
  url.protocol = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
  const response = await fetcher(`${url.origin}/api/orchestration/threads/${encodeURIComponent(parsed.localId)}/bounded?compactTurnItems=1&dedupeBodies=1&compactIds=1&deferWork=1`, {
    method: "GET", headers: { authorization: `Bearer ${bearer}`, "x-t3-orchestration-protocol": "2" },
  });
  const body = record(await response.json().catch(() => null));
  if (response.status === 404 && body?._tag === "EnvironmentResourceNotFoundError") return "missing";
  return response.status === 200 ? "present" : "unavailable";
}

export function installMissingThreadRoute() { setMissingThreadHook(handleMissingThread); setRemoteThreadProbe((id) => probeRemoteThread(id)); }
