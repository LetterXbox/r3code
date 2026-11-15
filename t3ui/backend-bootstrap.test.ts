import { expect, test } from "nsh/test";
import { parseLocalBootstrap } from "./backend/bootstrap";
import { importableProviderInstances, providerToggleMutation } from "./backend/providers";

test("a managed bootstrap accepts only a credential and loopback websocket", () => {
  expect(parseLocalBootstrap(JSON.stringify({ endpoint: "ws://127.0.0.1:3456/ws", token: " one-time " })))
    .toEqual({ endpoint: "ws://127.0.0.1:3456/ws", token: "one-time", importProviders: false });
  expect(parseLocalBootstrap(JSON.stringify({
    endpoint: "ws://127.0.0.1:3456/ws",
    token: "primary",
    serverEngine: "r3",
    additionalEnvironments: [
      { id: "saved:discovered-t3", label: "T3 Code", endpoint: "ws://127.0.0.1:4567/ws", token: " extra " },
      { label: "Remote", endpoint: "wss://example.com/ws", token: "ignored" },
    ],
  }))).toEqual({
    endpoint: "ws://127.0.0.1:3456/ws",
    token: "primary",
    importProviders: false,
    serverEngine: "r3",
    additionalEnvironments: [
      { id: "saved:discovered-t3", label: "T3 Code", endpoint: "ws://127.0.0.1:4567/ws", token: "extra" },
    ],
  });
  for (const endpoint of ["ws://example.com/ws", "wss://127.0.0.1/ws", "ws://127.0.0.1/ws?token=secret", "ws://user@127.0.0.1/ws", "ws://127.0.0.1/other"]) {
    expect(() => parseLocalBootstrap(JSON.stringify({ endpoint, token: "one-time" }))).toThrow("Invalid local backend bootstrap");
  }
  expect(() => parseLocalBootstrap(JSON.stringify({ endpoint: "ws://127.0.0.1/ws", token: "" }))).toThrow("Invalid local backend bootstrap");
});

test("provider toggles preserve settings and do not invent custom instances", () => {
  const instance = { driver: "codex", displayName: "Work", config: { model: "chosen" }, environment: [{ name: "KEY", value: "", sensitive: true, valueRedacted: true }] };
  const config = { providers: [{ instanceId: "work", driver: "codex" }, { instanceId: "codex", driver: "codex" }], settings: { providerInstances: { work: instance } } };
  expect(providerToggleMutation(config, "work", false)).toEqual({ operation: "upsert", instanceId: "work", instance: { ...instance, enabled: false } });
  expect(providerToggleMutation(config, "codex", true)).toEqual({ operation: "upsert", instanceId: "codex", instance: { driver: "codex", enabled: true } });
  expect(() => providerToggleMutation({ ...config, settings: { providerInstances: {} } }, "work", true)).toThrow("Provider settings are unavailable");
});

test("local provider import only carries approved built-in fields", () => {
  const imported = importableProviderInstances({ providerInstances: {
    grok: { driver: "grok", enabled: true, environment: [{ name: "TOKEN", value: "secret", sensitive: true }],
      config: { binaryPath: "/usr/local/bin/grok", customModels: ["vendor/model-v2", "https://secret.invalid/?token=secret"], apiKey: "secret", commandArgs: ["secret"] } },
    cursor: { driver: "cursor", enabled: false, config: { binaryPath: "https://secret.invalid/?token=secret", apiEndpoint: "https://secret.invalid/?token=secret" } },
    opencode: { driver: "opencode", config: { enabled: false, serverPassword: "secret" } },
    acpRegistry_devin: { driver: "acpRegistry", enabled: true, config: { commandPath: "/bin/agent", commandArgs: ["secret"] } },
    codex: { driver: "custom", enabled: true },
  } });
  expect(imported).toEqual([
    { instanceId: "grok", instance: { driver: "grok", enabled: true, config: { binaryPath: "/usr/local/bin/grok", customModels: ["vendor/model-v2"] } } },
    { instanceId: "cursor", instance: { driver: "cursor", enabled: false } },
    { instanceId: "opencode", instance: { driver: "opencode", enabled: false } },
  ]);
});
