import { expect, open, test } from "nsh/test";
import { exhaustedUsageWindow, fallbackModelItem, resolveNewThreadModelSelection } from "./fallbackModel";

const future = "2999-01-01T02:11:00.000Z";
const prov = (instanceId: string, used: number, extra: Record<string, unknown> = {}) => ({ instanceId, driver: instanceId, enabled: true, installed: true, availability: "available", auth: { status: "authenticated" }, usageLimits: { windows: [{ id: "w", usedPercent: used, resetsAt: future }] }, ...extra });
const base = { defaultSelection: { instanceId: "codex", model: "gpt" }, fallbackSelection: { instanceId: "claude", model: "haiku" }, now: 0 };

test("the default's exhausted window picks the fallback; otherwise the default stays", () => {
  expect(resolveNewThreadModelSelection({ ...base, providers: [prov("codex", 100), prov("claude", 0)] }).selection).toEqual(base.fallbackSelection);
  expect(resolveNewThreadModelSelection({ ...base, providers: [prov("codex", 99), prov("claude", 0)] }).fallback).toBe(null);
  expect(resolveNewThreadModelSelection({ ...base, providers: [prov("codex", 100), prov("claude", 100)] }).fallback).toBe(null);
  expect(resolveNewThreadModelSelection({ ...base, providers: [prov("codex", 100), prov("claude", 0, { auth: { status: "unauthenticated" } })] }).fallback).toBe(null);
  expect(resolveNewThreadModelSelection({ ...base, fallbackSelection: null, providers: [prov("codex", 100)] }).fallback).toBe(null);
  expect(resolveNewThreadModelSelection({ ...base, explicitSelection: base.defaultSelection, providers: [prov("codex", 100), prov("claude", 0)] }).fallback).toBe(null);
  expect(exhaustedUsageWindow(prov("codex", 100, { usageLimits: { windows: [{ id: "w", usedPercent: 100, resetsAt: "2000-01-01T00:00:00Z" }] } }), Date.now(), "gpt")).toBe(undefined);
});

test("the notice copy matches the reference", () => {
  const item = fallbackModelItem({ fallbackModelName: "Claude Haiku 5.5", defaultProviderName: "Codex", defaultModelName: "GPT-6.1-Sol", resetsAt: future, formatUpcoming: () => "2:11", onUseDefault: () => {}, onDismiss: () => {} });
  expect(item.title).toBe("Using Claude Haiku 5.5");
  expect(item.description).toBe("Codex is out of usage · resets 2:11");
  expect(item.actions[0]!.label).toBe("Use GPT-6.1-Sol");
  expect(item.dismissLabel).toBe("Dismiss fallback model notice");
  expect(fallbackModelItem({ fallbackModelName: "A", defaultProviderName: "Codex", defaultModelName: "B", resetsAt: null, formatUpcoming: () => "", onUseDefault: () => {}, onDismiss: () => {} }).description).toBe("Codex is out of usage");
});

test("a new draft starts on the fallback model and shows the notice", async () => {
  const app = await open("./FallbackModelFixture.tsx", { width: 780, height: 200, platform: "macos" });
  await expect(app.texts()).toContain("model:claude-haiku-5-5");
  await expect(app.texts()).toContain("Using Claude Haiku 5.5");
  await expect(app.texts().some((text) => text.startsWith("Codex is out of usage · resets "))).toBe(true);
  await expect(app.shows("label:Use GPT-6.1-Sol")).toBe(true);
});

test("Use <default> switches to the default model and hides the notice", async () => {
  const app = await open("./FallbackModelFixture.tsx", { width: 780, height: 200, platform: "macos" });
  await app.press("label:Use GPT-6.1-Sol");
  await expect(app.texts()).toContain("model:gpt-6.1-sol");
  await expect(app.shows("label:Dismiss fallback model notice")).toBe(false);
});

test("dismiss hides the notice; the model stays on the fallback", async () => {
  const app = await open("./FallbackModelFixture.tsx", { width: 780, height: 200, platform: "macos" });
  await app.press("label:Dismiss fallback model notice");
  await expect(app.shows("label:Dismiss fallback model notice")).toBe(false);
  await expect(app.texts()).toContain("model:claude-haiku-5-5");
});

test("the notice goes once the default provider has usage again", async () => {
  const app = await open("./FallbackModelFixture.tsx", { width: 780, height: 200, platform: "macos" });
  await expect(app.shows("label:Dismiss fallback model notice")).toBe(true);
  await app.press("label:Recover");
  await expect(app.shows("label:Dismiss fallback model notice")).toBe(false);
});

test("port screenshot of the notice (workspace/visual/fallback/port.png)", async () => {
  const app = await open("./FallbackModelFixture.tsx", { width: 780, height: 160, platform: "macos", colorScheme: "dark" });
  await expect(app.shows("label:Dismiss fallback model notice")).toBe(true);
  // Headless has no drawing platform: the shot is taken with `--target web --filter "port screenshot"`.
  try { await app.screenshot("workspace/visual/fallback/port.png"); } catch (error) { if (!String(error).includes("real platform")) throw error; }
});
