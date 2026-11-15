import { expect, test } from "nsh/test";
import {
  codexNeedsSetup,
  groupWelcomeAgents,
  onboardingProviderState,
  readWelcomeProvider,
  startButtonLabel,
  welcomeAgentAction,
  welcomeAgentDetail,
  welcomeAgentState,
} from "./welcomePage.logic";

// ServerProvider records as the config stream sends them.
const record = (instanceId: string, driver: string, overrides: Record<string, unknown> = {}) => ({
  instanceId, driver, displayName: instanceId, enabled: true, installed: true, version: "1.0.0", status: "ready", availability: "available",
  auth: { status: "authenticated" }, checkedAt: "2026-11-11T10:00:00.000Z", models: [], slashCommands: [], skills: [], ...overrides,
});
const read = (value: Record<string, unknown>) => readWelcomeProvider(value)!;

test("a provider record reads into the fields the page uses", () => {
  const provider = read(record("claudeAgent", "claudeAgent", { displayName: "Claude", message: "ok", compatibilityAdvisory: { status: "broken" }, setup: { canAuthenticate: true } }));
  expect(provider.displayName).toBe("Claude");
  expect(provider.compatibilityStatus).toBe("broken");
  expect(provider.canAuthenticate).toBe(true);
  expect(readWelcomeProvider({ driver: "codex" })).toBe(null);
  expect(read({ instanceId: "x", displayName: "  " }).displayName).toBe("x");
});

test("readiness follows the onboarding order: off, checking, install, sign in, ready, attention", () => {
  expect(onboardingProviderState(undefined)).toBe("checking");
  expect(onboardingProviderState(read(record("a", "codex", { enabled: false })))).toBe("disabled");
  expect(onboardingProviderState(read(record("a", "codex", { status: "disabled" })))).toBe("disabled");
  expect(onboardingProviderState(read(record("a", "codex", { installed: false, status: "warning", auth: { status: "unknown" } })))).toBe("checking");
  expect(onboardingProviderState(read(record("a", "codex", { installed: false, status: "error" })))).toBe("install");
  expect(onboardingProviderState(read(record("a", "codex", { auth: { status: "unauthenticated" } })))).toBe("signIn");
  expect(onboardingProviderState(read(record("a", "codex")))).toBe("ready");
  expect(onboardingProviderState(read(record("a", "codex", { status: "error" })))).toBe("attention");
});

test("an unavailable agent needs a look, a broken CLI is never ready, a settings override turns it off", () => {
  expect(welcomeAgentState(read(record("a", "codex", { availability: "unavailable" })), null)).toBe("attention");
  expect(welcomeAgentState(read(record("a", "codex", { compatibilityAdvisory: { status: "broken" } })), null)).toBe("attention");
  expect(welcomeAgentState(read(record("a", "codex")), { providerInstances: { a: { enabled: false } } })).toBe("disabled");
  expect(welcomeAgentState(read(record("a", "acpRegistry", { installed: false, status: "warning", auth: { status: "unknown" } })), null)).toBe("attention");
});

test("agents split into found and available, found ordered ready then sign in then attention, then by name", () => {
  const providers = [
    read(record("zed", "acp", { displayName: "Zed", enabled: false })),
    read(record("codex", "codex", { displayName: "Codex", auth: { status: "unauthenticated" } })),
    read(record("claudeAgent", "claudeAgent", { displayName: "Claude" })),
    read(record("opencode", "opencode", { displayName: "OpenCode", status: "error" })),
    read(record("amp", "amp", { displayName: "Amp", enabled: false })),
  ];
  const grouped = groupWelcomeAgents(providers, null);
  expect(grouped.found.map((provider) => provider.displayName)).toEqual(["Claude", "Codex", "OpenCode"]);
  expect(grouped.available.map((provider) => provider.displayName)).toEqual(["Amp", "Zed"]);
  expect(grouped.readyCount).toBe(1);
  expect(grouped.checking).toBe(false);
});

test("no provider list yet is checking, and an agent still being checked keeps it so", () => {
  expect(groupWelcomeAgents(null, null).checking).toBe(true);
  const checking = read(record("a", "codex", { installed: false, status: "warning", auth: { status: "unknown" } }));
  const grouped = groupWelcomeAgents([checking], null);
  expect(grouped.checking).toBe(true);
  expect(grouped.available).toEqual([checking]);
  expect(groupWelcomeAgents([read(record("a", "codex")), read(record("b", "codex"))], null, (provider) => provider.instanceId === "a").found.length).toBe(1);
});

test("each row carries the web's one action", () => {
  expect(welcomeAgentAction(read(record("a", "codex")), null)).toBe(null);
  expect(welcomeAgentAction(read(record("a", "opencode", { enabled: false })), null)).toEqual({ kind: "turnOn", label: "Turn on" });
  expect(welcomeAgentAction(read(record("a", "claudeAgent", { compatibilityAdvisory: { status: "broken" } })), null)).toEqual({ kind: "update", label: "Update" });
  expect(welcomeAgentAction(read(record("a", "codex", { auth: { status: "unauthenticated" } })), null)).toEqual({ kind: "setUp", label: "Set up" });
  expect(welcomeAgentAction(read(record("a", "claudeAgent", { installed: false, status: "error" })), null)).toEqual({ kind: "setUp", label: "Install" });
  expect(welcomeAgentAction(read(record("a", "claudeAgent", { auth: { status: "unauthenticated" } })), null)).toEqual({ kind: "signIn", label: "Sign in" });
  expect(welcomeAgentAction(read(record("a", "opencode", { auth: { status: "unauthenticated" } })), null)).toEqual({ kind: "signIn", label: "Sign in" });
  expect(welcomeAgentAction(read(record("a", "opencode", { status: "error" })), null)).toEqual({ kind: "details", label: "Details" });
});

test("Codex opens its setup card unless it is signed in or broken", () => {
  expect(codexNeedsSetup(read(record("a", "codex", { auth: { status: "unauthenticated" } })), null)).toBe(true);
  expect(codexNeedsSetup(read(record("a", "codex")), null)).toBe(false);
  expect(codexNeedsSetup(read(record("a", "claudeAgent", { auth: { status: "unauthenticated" } })), null)).toBe(false);
  expect(codexNeedsSetup(read(record("a", "codex", { auth: { status: "unauthenticated" }, compatibilityAdvisory: { status: "broken" } })), null)).toBe(false);
});

test("a detail line says why an agent that is on is not ready", () => {
  const attention = read(record("a", "opencode", { status: "error", message: "Binary missing", unavailableReason: "Not on PATH" }));
  expect(welcomeAgentDetail(attention, "attention", false)).toBe("Not on PATH");
  expect(welcomeAgentDetail(attention, "attention", true)).toBe(null);
  expect(welcomeAgentDetail(read(record("a", "opencode", { installed: false })), "install", false)).toBe("Not installed");
  expect(welcomeAgentDetail(read(record("a", "claudeAgent", { installed: false })), "install", false)).toBe(null);
  expect(welcomeAgentDetail(read(record("a", "codex")), "ready", false)).toBe(null);
  expect(startButtonLabel(false)).toBe("Start");
  expect(startButtonLabel(true)).toBe("Starting…");
});

import { welcomeAgentNotes } from "./welcomePage.logic";

test("scope notes: cannot control terminals / cannot manage agents", () => {
  const signIn = read(record("claudeAgent", "claudeAgent", { auth: { status: "unauthenticated" } }));
  const off = read(record("amp", "amp", { enabled: false }));
  expect(welcomeAgentNotes({ providers: [signIn, off], settings: null, canOperateTerminal: false, canManageProviders: false }))
    .toEqual(["This connection cannot control terminals.", "This connection cannot manage agents."]);
  expect(welcomeAgentNotes({ providers: [signIn, off], settings: null, canOperateTerminal: true, canManageProviders: true })).toEqual([]);
});
