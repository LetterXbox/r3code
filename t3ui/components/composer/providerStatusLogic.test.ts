import { expect, test } from "nsh/test";
import type { ProviderStatus } from "../../store";
import { antigravitySendBlockReason, getProviderStatusBannerKey, getProviderStatusMessage, providerBannerTitle, shouldShowProviderStatusBanner } from "./providerStatusLogic";

const base: ProviderStatus = {
  instanceId: "codex", driver: "codex", name: "Codex", enabled: true, installed: true, available: true, status: "ready",
  authStatus: "authenticated", authLabel: null, version: "1.0.0", unavailableReason: null, message: null, checkedAt: null,
  canInstall: false, canAuthenticate: false, models: [],
};

test("a healthy or disabled provider shows no banner", () => {
  expect(getProviderStatusBannerKey(base)).toBeNull();
  expect(getProviderStatusBannerKey({ ...base, status: "disabled" })).toBeNull();
  expect(getProviderStatusBannerKey(null)).toBeNull();
});

test("an error shows until dismissed and returns when the status changes", () => {
  const broken = { ...base, status: "error", authStatus: "unauthenticated" };
  const key = getProviderStatusBannerKey(broken);
  expect(key).not.toBeNull();
  expect(shouldShowProviderStatusBanner(broken, null)).toBe(true);
  expect(shouldShowProviderStatusBanner(broken, key)).toBe(false);
  expect(shouldShowProviderStatusBanner({ ...broken, message: "Token expired" }, key)).toBe(true);
});

test("titles and messages use the web copy", () => {
  expect(providerBannerTitle({ ...base, status: "error", authStatus: "unauthenticated" })).toBe("Codex is unauthenticated");
  expect(providerBannerTitle({ ...base, status: "warning" })).toBe("Codex provider status");
  expect(getProviderStatusMessage({ ...base, status: "error", authStatus: "unauthenticated" })).toBe("Sign in via the CLI to authenticate again.");
  expect(getProviderStatusMessage({ ...base, status: "error", authStatus: "unauthenticated", canAuthenticate: true })).toBe("Open provider setup to sign in.");
  expect(getProviderStatusMessage({ ...base, status: "warning" })).toBe("Codex provider has limited availability.");
  expect(getProviderStatusMessage({ ...base, installed: false, canInstall: true, status: "error" })).toBe("Open provider setup to install codex on this environment.");
});

test("antigravitySendBlockReason: install, sign in, choose, refresh, stale model", () => {
  const base = { driver: "antigravity", installed: true, authStatus: "authenticated", status: "ready", models: [{ id: "gemini-3", name: "Gemini 3" }] };
  expect(antigravitySendBlockReason({ ...base, driver: "codex" }, "x")).toBeNull();
  expect(antigravitySendBlockReason({ ...base, installed: false }, "gemini-3")).toBe("Install Antigravity in provider settings before sending.");
  expect(antigravitySendBlockReason({ ...base, authStatus: "unauthenticated" }, "gemini-3")).toBe("Sign in to Antigravity in provider settings before sending.");
  expect(antigravitySendBlockReason(base, " ")).toBe("Choose an Antigravity model before sending.");
  expect(antigravitySendBlockReason({ ...base, authStatus: "unknown", models: [] }, "gemini-3")).toBeNull();
  expect(antigravitySendBlockReason({ ...base, models: [] }, "gemini-3")).toBe("Refresh Antigravity models in provider settings before sending.");
  expect(antigravitySendBlockReason(base, "gone")).toBe("That Antigravity model is no longer available. Choose another model.");
  expect(antigravitySendBlockReason(base, "antigravity-default")).toBeNull();
  expect(antigravitySendBlockReason(base, "gemini-3")).toBeNull();
});
