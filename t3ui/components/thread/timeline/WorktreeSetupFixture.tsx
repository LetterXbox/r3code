import { mount, signal, View } from "nsh";
import { WorktreeSetupCard } from "./WorktreeSetupCard";
import { readWorktreeSetupSnapshot } from "./worktreeSetup";

// A WorktreeSetupSnapshot as subscribeWorktreeSetup streams it (contracts worktreeSetup.ts).
const stage = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, status, startedAt: "2026-01-01T00:00:00Z", endedAt: status === "running" || status === "pending" ? null : "2026-01-01T00:00:02Z", percent: null, detail: null, tail: [], ...extra });
const snapshot = readWorktreeSetupSnapshot({
  threadId: "t1", phase: "running", startedAt: "2026-01-01T00:00:00Z", endedAt: null, branch: "t3/feature", baseRef: "main", worktreePath: "/w/feature",
  setupScript: { name: "bun install", command: "bun install", terminalId: "setup-1" },
  stages: [stage("fetch", "done"), stage("checkout", "done"), stage("setup-script", "running", { tail: ["resolving", "linking"] }), stage("agent", "pending")],
  error: null, sequence: 3,
})!;
const calls = signal<string[]>([]);

function Fixture() {
  return (
    <View>
      <WorktreeSetupCard snapshot={() => snapshot} send={async (method, payload) => { calls.update((all) => [...all, `${method}:${JSON.stringify(payload)}`]); return { cancelled: true }; }} />
      <View accessibilityLabel={calls().join("|")} class="size-4" />
    </View>
  );
}

mount(Fixture);
