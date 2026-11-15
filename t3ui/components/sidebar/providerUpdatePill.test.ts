import { expect, test } from "nsh/test";
import { pillStep } from "./providerPillSwap";
import { getProviderUpdatePillView, latestProviderCheckedAt } from "./providerUpdatePill";

const provider = (driver: string, status: string | null, extra: Record<string, unknown> = {}) => ({
  instanceId: driver, driver, name: driver === "claudeAgent" ? "Claude" : "Codex", version: "1.2.3",
  checkedAt: "2026-01-01T00:00:00Z", latestVersion: null,
  updateState: status ? { status, message: null, finishedAt: "2026-01-02T00:00:00Z" } : null, ...extra,
});

test("nothing is reported while no provider updates", () => {
  expect(getProviderUpdatePillView([provider("codex", null)])).toBe(null);
});

test("a running update reads Updating <name>, and several read Updating N providers", () => {
  const one = getProviderUpdatePillView([provider("codex", "running")]);
  expect(one?.tone).toBe("loading");
  expect(one?.title).toBe("Updating Codex");
  expect(one?.description).toBe("Codex update in progress.");
  const two = getProviderUpdatePillView([provider("codex", "queued"), provider("claudeAgent", "running")]);
  expect(two?.title).toBe("Updating 2 providers");
  expect(two?.description).toBe("Codex and Claude updates are in progress.");
});

test("a finished update shows its result, newest first, and only after the visible-after time", () => {
  const failed = getProviderUpdatePillView([provider("codex", "failed", { latestVersion: "2.0.0", updateState: { status: "failed", message: "disk full", finishedAt: "2026-01-02T00:00:00Z" } })]);
  expect(failed?.tone).toBe("error");
  expect(failed?.title).toBe("Codex v2.0.0 update failed");
  expect(failed?.description).toBe("disk full");
  expect(failed?.dismissible).toBe(true);
  const ok = getProviderUpdatePillView([provider("codex", "succeeded")]);
  expect(ok?.title).toBe("Codex updated: v1.2.3");
  expect(ok?.dismissAfterVisibleMs).toBe(3000);
  expect(getProviderUpdatePillView([provider("codex", "succeeded")], { visibleAfterIso: "2026-02-01T00:00:00Z" })).toBe(null);
});

test("a dismissed result gives way to the next one", () => {
  const providers = [provider("codex", "failed"), provider("claudeAgent", "unchanged")];
  const first = getProviderUpdatePillView(providers);
  expect(first?.tone).toBe("error");
  const next = getProviderUpdatePillView(providers, { dismissedKeys: new Set([first!.key]) });
  expect(next?.tone).toBe("warning");
  expect(next?.title).toBe("Claude still needs an update");
});

test("the latest check time is the newest checkedAt", () => {
  expect(latestProviderCheckedAt([{ checkedAt: "2026-01-01T00:00:00Z" }, { checkedAt: "2026-03-01T00:00:00Z" }, { checkedAt: null }])).toBe("2026-03-01T00:00:00Z");
  expect(latestProviderCheckedAt([])).toBe(undefined);
});

test("a pill whose view changes key exits before the next shows (SidebarProviderUpdatePill.tsx:94-100)", () => {
  expect(pillStep(null, "a")).toBe("show");
  expect(pillStep("a", "a")).toBe("update");
  expect(pillStep("a", "b")).toBe("exit");
  expect(pillStep("a", null)).toBe("exit");
});
