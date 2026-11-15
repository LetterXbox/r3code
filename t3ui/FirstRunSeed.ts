// Contract-shaped server data pushed through the store's real ingestion hooks before the app mounts (FirstRunFixture imports a
// scenario of this first): the config snapshot, the shell snapshot, the lifecycle welcome and a connected session, with the first-run
// gate told a session credential exists (a fixture store keeps none).
import { observeLifecycleEvent } from "./components/coordinators/serverStreams";
import { forceFirstRunGateForTest, resetFirstRunForTest } from "./components/onboarding/firstRunState";
import { applyConfigEventForTest, applyShellEventForTest, setBackendStatusForTest } from "./store";

const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

export const provider = (instanceId: string, driver: string, displayName: string, overrides: Record<string, unknown> = {}) => ({
  instanceId, driver, displayName, enabled: true, installed: true, version: "1.0.0", status: "ready", availability: "available",
  auth: { status: "authenticated" }, checkedAt: iso(1), models: [], slashCommands: [], skills: [], ...overrides,
});

export interface SeedOptions {
  providers: unknown[];
  /** The server's own cwd project and thread, which is all a brand-new install has. */
  fresh: boolean;
  completed?: string | null;
}

export function seedServer(options: SeedOptions) {
  const environment = { environmentId: "environment-first", label: "legion", serverVersion: "0.1.8", capabilities: { projectOrganization: true, attachmentUploads: false } };
  applyConfigEventForTest({ type: "snapshot", config: { environment, providers: options.providers } });
  const project = { id: "project-1", title: "legion", workspaceRoot: "/work/legion", archivedAt: null, pinnedAt: null, scripts: [], createdAt: iso(5), updatedAt: iso(5) };
  const thread = (id: string, ran: boolean) => ({
    id, projectId: "project-1", title: ran ? "Fix the build" : "New thread", status: ran ? "completed" : "idle", runtimeMode: "full-access", interactionMode: "default",
    branch: "main", worktreePath: null, latestUserMessageAt: ran ? iso(3) : null, createdAt: iso(5), updatedAt: iso(3), latestRunId: ran ? "run-1" : null,
    pinnedAt: null, archivedAt: null, session: null, pendingRuntimeRequest: null, modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" },
  });
  applyShellEventForTest({ kind: "snapshot", snapshot: { projects: [project], threads: [thread("thread-1", !options.fresh)], archivedThreads: [] } });
  observeLifecycleEvent({
    version: 1, sequence: 1, type: "welcome",
    payload: { environment: { ...environment, platform: { os: "darwin", arch: "arm64" } }, cwd: "/work/legion", projectName: "legion", bootstrapStatus: "complete", bootstrapProjectId: "project-1", bootstrapThreadId: "thread-1", bootstrapProjectCreated: options.fresh, bootstrapThreadCreated: options.fresh },
  });
  forceFirstRunGateForTest(true);
  resetFirstRunForTest({ completed: options.completed ?? null });
  setBackendStatusForTest("connected");
}
