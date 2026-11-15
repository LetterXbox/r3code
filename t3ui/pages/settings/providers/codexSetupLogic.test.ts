import { expect, test } from "nsh/test";
import type { ProviderAuthState, ProviderInstallState } from "../../../backend/providerSetup";
import { readCodexSetupMode, settleAuthorizationPage, settleProviderInstall } from "./codexSetupLogic";

const install = (phase: ProviderInstallState["phase"], extra: Partial<ProviderInstallState> = {}): ProviderInstallState =>
  ({ driver: "codex", operationId: "op", phase, downloadedBytes: 0, totalBytes: null, version: null, installedVersion: null, canRemove: false, message: null, ...extra });
const auth = (phase: ProviderAuthState["phase"], extra: Partial<ProviderAuthState> = {}): ProviderAuthState =>
  ({ instanceId: "codex", phase, flowId: "f1", authorizationUrl: null, expiresAt: null, message: null, methods: [], interaction: null, ...extra });

test("the setup mode is managed only when the config says so", () => {
  expect(readCodexSetupMode({ setupMode: "managed" })).toBe("managed");
  expect(readCodexSetupMode({ setupMode: "existing" })).toBe("existing");
  expect(readCodexSetupMode(undefined)).toBe("existing");
});

test("an install settles only on its own operation and only a usable runtime counts", () => {
  expect(settleProviderInstall(install("downloading"), null)).toBeUndefined();
  expect(settleProviderInstall(install("downloading"), install("downloading", { operationId: "other" }))).toBeUndefined();
  expect(settleProviderInstall(install("downloading"), install("succeeded", { installedVersion: "1.0" }))).toBe(true);
  expect(settleProviderInstall(install("downloading"), install("failed"))).toBe(false);
  expect(settleProviderInstall(install("cancelled"), null)).toBe(false);
});

test("the authorization page appears once the flow waits and clears when it ends", () => {
  expect(settleAuthorizationPage(null, null)).toBeUndefined();
  expect(settleAuthorizationPage(auth("starting"), "f1")).toBeUndefined();
  expect(settleAuthorizationPage(auth("waiting", { authorizationUrl: "https://auth.example" }), "f1")).toBe("https://auth.example");
  expect(settleAuthorizationPage(auth("waiting", { interaction: { type: "browser", id: "i", url: "https://b.example", requiresConsent: false } }), null)).toBe("https://b.example");
  expect(settleAuthorizationPage(auth("waiting", { authorizationUrl: "https://auth.example" }), "f2")).toBeUndefined();
  expect(settleAuthorizationPage(auth("failed"), "f1")).toBeNull();
});
