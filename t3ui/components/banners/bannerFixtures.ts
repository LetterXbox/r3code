// Contract-shaped payloads for the banner tests: one OrchestrationV2ThreadShell as `orchestration.subscribeShell`
// sends it, and one provider snapshot as `server.getConfig` carries it.
import type { ProviderStatus } from "../../store";

export function shellThread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "thread-1", projectId: "project-1", title: "Fix the build", providerInstanceId: "claudeAgent",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
    runtimeMode: "full-access", interactionMode: "default", branch: "main", worktreePath: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: null, sideChat: false },
    latestRunId: "run-1", latestRunStartedAt: "2026-11-11T10:00:00.000Z", latestRunCompletedAt: "2026-11-11T10:05:00.000Z",
    latestRunStopRequested: false, activeRunId: null, activityRunStatus: null, status: "idle",
    lastError: null, lastErrorClass: null, lastErrorCode: null, usageLimitResetAt: null, pendingRuntimeRequest: null,
    pendingBackgroundTasks: [], goal: null, limitRecovery: null, snoozedUntil: null, settledOverride: null,
    createdAt: "2026-11-11T09:00:00.000Z", updatedAt: "2026-11-11T10:05:00.000Z",
    ...overrides,
  };
}

export const providerStatus: ProviderStatus = {
  instanceId: "claudeAgent", driver: "claudeAgent", name: "Claude", enabled: true, installed: true, available: true, status: "ready",
  authStatus: "authenticated", authLabel: null, version: "2.3.1", unavailableReason: null, message: null, checkedAt: null,
  canInstall: false, canAuthenticate: false, models: [],
};
