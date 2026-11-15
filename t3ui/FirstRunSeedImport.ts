// A fresh workspace whose agents' history holds three projects: `agentSessions.scan` answers with them, `projects.mutate` and
// `agentSessions.import` accept (the import brings 4 threads per project).
import { provider, seedServer } from "./FirstRunSeed";
import { applyShellEventForTest, setRequestBackendForTest } from "./store";

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

const BASE_PROJECT = { id: "project-1", title: "legion", workspaceRoot: "/work/legion", archivedAt: null, pinnedAt: null, scripts: [], createdAt: iso(5), updatedAt: iso(5) };
const created: Record<string, unknown>[] = [];

setRequestBackendForTest(async (method, payload) => {
  if (method === "agentSessions.scan") {
    return {
      scannedAt: iso(0),
      candidates: [
        { path: "/work/alpha", title: "alpha", sources: ["claudeAgent"], threadCount: 5, lastActiveAt: iso(1), alreadyImported: false, git: { remoteKey: "github.com/me/alpha", repository: "me/alpha" } },
        { path: "/work/beta", title: "beta", sources: ["codex", "claudeAgent"], threadCount: 3, lastActiveAt: iso(2), alreadyImported: false, git: { remoteKey: "github.com/me/beta", repository: "me/beta" } },
        { path: "/work/notes", title: "notes", sources: ["pi"], threadCount: 1, lastActiveAt: iso(90), alreadyImported: false, git: null },
      ],
    };
  }
  if (method === "agentSessions.import") return { importedCount: 4, skippedCount: 0 };
  // A server announces a created project on the shell stream; Start waits for the landing project to appear (waitForProject).
  if (method === "projects.mutate") {
    const command = payload as { projectId: string; title: string; workspaceRoot: string };
    created.push({ id: command.projectId, title: command.title, workspaceRoot: command.workspaceRoot, archivedAt: null, pinnedAt: null, scripts: [], createdAt: iso(0), updatedAt: iso(0) });
    applyShellEventForTest({ kind: "snapshot", snapshot: { projects: [BASE_PROJECT, ...created], threads: [], archivedThreads: [] } });
    return {};
  }
  return {};
});
seedServer({ fresh: true, providers: [provider("claudeAgent", "claudeAgent", "Claude")] });
