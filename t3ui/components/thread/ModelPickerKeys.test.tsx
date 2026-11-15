import { expect, open, test } from "nsh/test";
import { modelDisabledReason } from "./ModelPicker";
import { usesChatGptSharingRecord } from "../composer/ChatGptSharingControl";
import { resolveModelMentionIn } from "./markdown/modelMentionPresentation";

test("a model the thread cannot take is dimmed with the reason, and pressing it picks nothing", async () => {
  const app = await open("./ModelPickerKeysFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.press("label:Provider B");
  await expect(app.shows("label:Model B, Provider B")).toBe(true);
  await app.press("label:Model B, Provider B");
  await expect(app.texts()).toContain("picked none");
  await app.press("label:Provider A");
  await app.press("label:Model C, Provider A");
  await expect(app.texts()).toContain("picked first/model-c");
});

test("the ChatGPT plan footer names the plan and offers Manage usage", async () => {
  const app = await open("./ModelPickerKeysFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await expect(app.shows("label:Using ChatGPT plan")).toBe(true);
  await expect(app.shows("label:Manage usage")).toBe(true);
});

test("a selected model the provider no longer offers shows the Unavailable badge on the trigger", async () => {
  const app = await open("./ModelPickerKeysFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await expect(app.shows("label:Unavailable")).toBe(true);
});

test("the keyboard: Shift+Tab from the search goes to the rail, Right returns, Right at the end picks the highlighted model and moves to the effort levels", async () => {
  const app = await open("./ModelPickerKeysFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.keyboard.press("down");
  await app.keyboard.press("shift+tab");
  await app.keyboard.press("down");
  await app.keyboard.press("up");
  await app.keyboard.press("right");
  // Back in the search field: Right with the caret at the end (empty text) picks the highlighted model (Model C, after Down).
  await app.keyboard.press("right");
  await app.waitUntil(() => app.texts().includes("picked first/model-c"));
  // The levels have the keyboard: Down moves between them and Left returns to the search.
  await app.wait(100);
  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.texts().includes("effort high"));
  await app.keyboard.press("left");
});

test("the disabled reason: the picker being disabled wins, else a started thread's block with the web's suffix", () => {
  expect(modelDisabledReason({ pickerDisabled: true, blocked: { description: "x" } })).toBe("Model picker is disabled");
  expect(modelDisabledReason({ pickerDisabled: false, blocked: { description: "This thread does not support switching providers after it has started." } })).toBe("This thread does not support switching providers after it has started. Start a new thread to use this model.");
  expect(modelDisabledReason({ pickerDisabled: false, blocked: null })).toBe(null);
});

test("ChatGPT sharing needs an authenticated provider that shares the subscription", () => {
  expect(usesChatGptSharingRecord({ auth: { status: "authenticated", subscriptionSharing: true } })).toBe(true);
  expect(usesChatGptSharingRecord({ auth: { status: "authenticated" } })).toBe(false);
  expect(usesChatGptSharingRecord({ auth: { status: "unauthenticated", subscriptionSharing: true } })).toBe(false);
  expect(usesChatGptSharingRecord(null)).toBe(false);
});

test("a model mention resolves against the provider snapshots: its name, provider and accent; an unlisted model stays text", () => {
  const records = [{ instanceId: "codex_work", driver: "codex", displayName: "Codex", accentColor: "#112233", models: [{ slug: "gpt-6.1-sol", name: "GPT 6.1 Sol", subProvider: null }, { slug: "x/y", name: "Y", subProvider: "Router" }] }];
  expect(resolveModelMentionIn(records, "codex_work", "gpt-6.1-sol")).toMatchObject({ label: "GPT 6.1 Sol", driver: "codex", accentColor: "#112233", instanceId: "codex_work" });
  expect(resolveModelMentionIn(records, "codex_work", "x/y")?.providerLabel).toBe("Router");
  expect(resolveModelMentionIn(records, "codex_work", "gone")).toBe(null);
  expect(resolveModelMentionIn(records, "nope", "gpt-6.1-sol")).toBe(null);
});
