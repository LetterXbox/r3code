import { expect, test } from "nsh/test";
import { runChatGptHandoff, shouldHandOffToPrimary } from "./backend/chatgptHandoff";
import { adjustServerPreview, serverTabZoomFor } from "./components/rightPanel/serverPreviewAdjust";

const authState = (phase: string) => ({ instanceId: "codex", phase, flowId: "f1", authorizationUrl: null, interaction: null, expiresAt: null, message: null, methods: [] });

test("a remote reconnect hands the ChatGPT sign-in to the loopback primary and imports the profile", async () => {
  const remoteCalls: [string, unknown][] = [];
  let push: ((value: unknown) => void) | null = null;
  let subscribed: unknown = null;
  const phases: string[] = [];
  const handoff = runChatGptHandoff({
    remote: async (method, payload) => { remoteCalls.push([method, payload]); return method === "provider.chatgpt.reconnect-profile" ? { accountId: "a" } : null; },
    primarySubscribe: (method, payload, onValue) => { expect(method).toBe("provider.chatgpt.handoff.subscribe"); subscribed = payload; push = onValue; return () => {}; },
  }, { instanceId: "codex", methodId: "chatgpt-profile:1", remoteEnvironmentId: "env-remote", returnUrl: "t3code://settings/providers", onAuth: (state) => phases.push(state.phase) });
  for (let i = 0; i < 50 && !push; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  expect((subscribed as { environmentId: string; profile: unknown }).environmentId).toBe("env-remote");
  expect((subscribed as { profile: unknown }).profile).toEqual({ accountId: "a" });
  push!({ phase: "auth", state: authState("waiting") });
  push!({ phase: "finished", profile: { registration: { accountId: "a" }, credentials: {} } });
  await handoff.done;
  expect(phases).toEqual(["waiting"]);
  expect(remoteCalls.map(([method]) => method)).toEqual(["provider.chatgpt.reconnect-profile", "provider.chatgpt.import-profile"]);
  expect(remoteCalls[1][1]).toEqual({ instanceId: "codex", profile: { registration: { accountId: "a" }, credentials: {} } });
});

test("a failed primary sign-in rejects with its message; routing hands off only remote targets from a loopback primary", async () => {
  let push: ((value: unknown) => void) | null = null;
  const handoff = runChatGptHandoff({ remote: async () => null, primarySubscribe: (_m, _p, onValue) => { push = onValue; return () => {}; } },
    { instanceId: "codex", methodId: "m", remoteEnvironmentId: "e", returnUrl: "x", onAuth: () => {} });
  for (let i = 0; i < 50 && !push; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  push!({ phase: "auth", state: { ...authState("failed"), message: "Denied" } });
  expect(await handoff.done.then(() => "ok", (error: Error) => error.message)).toBe("Denied");
  expect(shouldHandOffToPrimary({ targetUrl: "wss://box.example/ws", primaryUrl: "ws://127.0.0.1:3773/ws", primaryConnected: true })).toBe(true);
  expect(shouldHandOffToPrimary({ targetUrl: "ws://localhost:4000/ws", primaryUrl: "ws://127.0.0.1:3773/ws", primaryConnected: true })).toBe(false);
  expect(shouldHandOffToPrimary({ targetUrl: "wss://box.example/ws", primaryUrl: "wss://other.example/ws", primaryConnected: true })).toBe(false);
});

test("preview.adjust carries the server tab's zoom and hard reload", async () => {
  const sent: [string, unknown][] = [];
  expect(await adjustServerPreview("t", "tab", { zoomFactor: 1.25 }, async (method, payload) => { sent.push([method, payload]); return { zoomFactor: 1.25 }; })).toBe(true);
  expect(serverTabZoomFor("tab")).toBe(1.25);
  await adjustServerPreview("t", "tab", { hardReload: true }, async (method, payload) => { sent.push([method, payload]); return {}; });
  expect(sent).toEqual([["preview.adjust", { threadId: "t", tabId: "tab", zoomFactor: 1.25 }], ["preview.adjust", { threadId: "t", tabId: "tab", hardReload: true }]]);
});
