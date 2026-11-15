import { expect, test } from "nsh/test";
import { createActivityReport, LEASE_TTL_MS, retainedScopes, retainScope, scopeForSubscription } from "./backgroundActivity";

test("vcs status with the remote and resource telemetry keep scopes; other streams do not", () => {
  expect(scopeForSubscription("subscribeVcsStatus", { cwd: "/p" })).toEqual({ type: "vcs-status", cwd: "/p" });
  expect(scopeForSubscription("subscribeVcsStatus", { cwd: "/p", includeRemote: false })).toBe(null);
  expect(scopeForSubscription("subscribeResourceTelemetry", {})).toEqual({ type: "diagnostics" });
  expect(scopeForSubscription("orchestration.subscribeShell", {})).toBe(null);
});

test("scopes are ref-counted per folder", () => {
  const a = retainScope({ type: "vcs-status", cwd: "/p" });
  const b = retainScope({ type: "vcs-status", cwd: "/p" });
  expect(retainedScopes()).toEqual([{ type: "vcs-status", cwd: "/p" }]);
  a();
  a();
  expect(retainedScopes().length).toBe(1);
  b();
  expect(retainedScopes()).toEqual([]);
});

test("the report is contract-shaped: baseline provider-status first, lease ttl, ISO observedAt", () => {
  const now = Date.parse("2026-11-13T10:00:00Z");
  const report = createActivityReport({ environmentId: "env-1", clientId: "c1", appState: "active", lastInteractionAt: now - 1000, now, scopes: [{ type: "vcs-status", cwd: "/p" }] });
  expect(report).toEqual({
    environmentId: "env-1", clientId: "c1", clientKind: "desktop-renderer", visible: true, focused: true, recentlyInteracted: true, appState: "active",
    scopes: [{ type: "provider-status" }, { type: "vcs-status", cwd: "/p" }], ttlMs: LEASE_TTL_MS, observedAt: "2026-11-13T10:00:00.000Z",
  });
  const away = createActivityReport({ environmentId: null, clientId: "c1", appState: "background", lastInteractionAt: now - LEASE_TTL_MS - 1, now, scopes: [] });
  expect([away.visible, away.focused, away.recentlyInteracted, away.appState, "environmentId" in away]).toEqual([false, false, false, "background", false]);
});
