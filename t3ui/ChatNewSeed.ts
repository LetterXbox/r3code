// Two projects in the shell snapshot, applied before the app mounts (ChatNewFixture imports this first).
import { applyShellEventForTest } from "./store";

const project = (id: string, title: string, workspaceRoot: string) => ({
  id, title, workspaceRoot, archivedAt: null, pinnedAt: null, scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
});

applyShellEventForTest({ kind: "snapshot", snapshot: { threads: [], archivedThreads: [], projects: [project("project:a", "alpha", "/work/alpha"), project("project:b", "beta", "/work/beta")] } });
