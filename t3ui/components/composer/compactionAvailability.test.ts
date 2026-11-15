import { expect, test } from "nsh/test";
import { hasAvailableCompactionProvider, lockedCompactionInstanceId } from "./composerAvailability";

const compact = [{ name: "compact" }];
const provider = (instanceId: string, groupKey: string, slashCommands: unknown[], extra: Record<string, unknown> = {}) => ({ instanceId, driver: "claudeAgent", enabled: true, status: "ready", continuation: { groupKey }, slashCommands, ...extra });

test("manual /compact follows the instance a send would use within the started thread's continuation group (compaction.logic)", () => {
  const providers = [provider("claude-a", "home", compact), provider("claude-b", "work", []), { instanceId: "codex", driver: "codex", enabled: true, status: "ready", slashCommands: compact }];
  // Unlocked draft: the selected instance decides.
  expect(hasAvailableCompactionProvider({ providers, driverKind: "claudeAgent", instanceId: "claude-a", lockedInstanceId: null })).toBe(true);
  expect(hasAvailableCompactionProvider({ providers, driverKind: "claudeAgent", instanceId: "claude-b", lockedInstanceId: null })).toBe(false);
  // Locked to claude-a's group: a selected instance outside it falls back to the group's ready instance.
  expect(hasAvailableCompactionProvider({ providers, driverKind: "claudeAgent", instanceId: "claude-b", lockedInstanceId: "claude-a" })).toBe(true);
  // Locked to claude-b's group, whose only instance offers no compact.
  expect(hasAvailableCompactionProvider({ providers, driverKind: "claudeAgent", instanceId: "claude-a", lockedInstanceId: "claude-b" })).toBe(false);
  // An unavailable selected instance is skipped for the first ready one.
  const down = [provider("claude-a", "home", [], { availability: "unavailable" }), provider("claude-c", "home", compact)];
  expect(hasAvailableCompactionProvider({ providers: down, driverKind: "claudeAgent", instanceId: "claude-a", lockedInstanceId: null })).toBe(true);
  expect(hasAvailableCompactionProvider({ providers, driverKind: null, instanceId: null, lockedInstanceId: null })).toBe(false);
});

test("a thread is locked once it has a run or provider session, to its runtime instance else its model selection", () => {
  expect(lockedCompactionInstanceId(null)).toBe(null);
  expect(lockedCompactionInstanceId({ runs: [], providerSessions: [], thread: { modelSelection: { instanceId: "claude-a" } } })).toBe(null);
  expect(lockedCompactionInstanceId({ runs: [{}], thread: { modelSelection: { instanceId: "claude-a" } } })).toBe("claude-a");
  expect(lockedCompactionInstanceId({ providerSessions: [{}], thread: { runtime: { providerInstanceId: "claude-b" }, modelSelection: { instanceId: "claude-a" } } })).toBe("claude-b");
});
