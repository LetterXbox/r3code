// Contract-shaped server data pushed through the store's real ingestion hooks before the app mounts
// (PaletteLiveFixture imports this first): one project, eight threads and the providers a server reports.
import { applyConfigEventForTest, applyShellEventForTest } from "./store";

const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const model = (slug: string, name: string) => ({ slug, name, isCustom: false, capabilities: { optionDescriptors: [] } });
const provider = (instanceId: string, driver: string, displayName: string, models: ReturnType<typeof model>[], usageLimits?: unknown) => ({
  instanceId, driver, displayName, enabled: true, installed: true, version: "1.0.0", status: "ready", availability: "available",
  auth: { status: "authenticated" }, checkedAt: iso(1), models, slashCommands: [], skills: [], ...(usageLimits ? { usageLimits } : {}),
});

applyConfigEventForTest({
  type: "snapshot",
  config: {
    environment: { environmentId: "environment-live", label: "legion", capabilities: { projectOrganization: true, attachmentUploads: false } },
    providers: [
      provider("claudeAgent", "claudeAgent", "Claude", [model("claude-opus-5-5", "Opus 5.5"), model("claude-haiku-5-5", "Haiku 5.5")], {
        checkedAt: iso(1),
        windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 59, resetsAt: new Date(NOW + 86_400_000).toISOString(), windowDurationMins: 10080 }],
      }),
      provider("codex", "codex", "Codex", [model("gpt-6-sol", "GPT-6 Sol")]),
    ],
  },
});

const thread = (n: number) => ({
  id: `thread-${n}`, projectId: "project-live", title: `Live thread ${n}`, status: "idle", runtimeMode: "full-access", interactionMode: "default",
  branch: "main", worktreePath: null, latestUserMessageAt: iso(n * 7), createdAt: iso(n * 9), updatedAt: iso(n * 7),
  pinnedAt: null, archivedAt: null, session: null, pendingRuntimeRequest: null, modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" },
});

applyShellEventForTest({
  kind: "snapshot",
  snapshot: {
    projects: [{ id: "project-live", title: "legion", workspaceRoot: "/work/legion", archivedAt: null, pinnedAt: null, scripts: [], createdAt: iso(5000), updatedAt: iso(3) }],
    threads: Array.from({ length: 8 }, (_unused, index) => thread(index + 1)),
    archivedThreads: [],
  },
});
