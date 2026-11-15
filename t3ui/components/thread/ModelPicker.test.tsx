import { expect, open, test } from "nsh/test";

test("the picker trigger names the model and the popover lists providers with search and favorites", async () => {
  const app = await open("./ModelPickerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await expect(app.texts()).toContain("Model A");
  await app.press("label:Select model");
  await expect(app.texts()).toContain("Model A");
  await expect(app.shows("label:Favorites")).toBe(true);
  await expect(app.shows("label:Provider B")).toBe(true);
  await app.press("label:Provider B");
  await app.press("label:Model B, Provider B");
  await expect(app.texts()).toContain("Model B");
  // The popover plays its 150ms exit (ui/popover.tsx:95) before it goes.
  await app.wait(250);
  await expect(app.shows("label:Search models")).toBe(false);
});

test("search spans providers, favourites persist per row, and empty states use the web copy", async () => {
  const app = await open("./ModelPickerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.press("label:Select model");
  await app.press("label:Favorites");
  await expect(app.texts()).toContain("No favorites yet");
  await app.press("label:Provider A");
  await app.press("label:Add to favorites");
  await app.press("label:Favorites");
  await expect(app.shows("label:Model A, Provider A")).toBe(true);
  await app.type("label:Search models", "zzz");
  await expect(app.texts()).toContain("No models found");
});

test("typing in search lists matching models from every provider", async () => {
  const app = await open("./ModelPickerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.press("label:Select model");
  await app.type("label:Search models", "model b");
  await expect(app.shows("label:Model B, Provider B")).toBe(true);
  await expect(app.shows("label:Model A, Provider A")).toBe(false);
});

test("mod+shift+m toggles the picker, mod+shift+down steps the provider and mod+2 picks the second row", async () => {
  const app = await open("./ModelPickerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.keyboard.press("mod+shift+m");
  await app.waitUntil(() => app.shows("label:Search models"));
  await app.keyboard.press("mod+shift+m");
  await app.waitUntil(() => !app.shows("label:Search models"));
  await app.keyboard.press("mod+shift+m");
  await app.waitUntil(() => app.shows("label:Search models"));
  await expect(app.shows("label:Model B, Provider B")).toBe(false);
  await app.keyboard.press("mod+shift+down");
  await app.waitUntil(() => app.shows("label:Model B, Provider B") || app.shows("label:Model A, Provider A"));
  await app.type("label:Search models", "model");
  await app.waitUntil(() => app.shows("label:Model B, Provider B") && app.shows("label:Model A, Provider A"));
  await app.keyboard.press("mod+2");
  await app.waitUntil(() => app.texts().includes("Model B") && !app.shows("label:Search models"));
});

test("the selected model's row is the highlighted one and shows an outline star; favouriting fills it", async () => {
  const app = await open("./ModelPickerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.press("label:Select model");
  await expect(app.shows("label:Model A, Provider A")).toBe(true);
  await expect(app.shows("label:Add to favorites")).toBe(true);
  await app.press("label:Add to favorites");
  await expect(app.shows("label:Remove from favorites")).toBe(true);
});

test("the docked picker footer has no Default/Plan toggle", async () => {
  const app = await open("./EffortPickerFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.press("label:Select model");
  await expect(app.shows("label:Interaction mode: Plan")).toBe(false);
  await expect(app.shows("label:Interaction mode: Default")).toBe(false);
});

test("a provider that needs sign-in says why under its models and opens its setup; a newer CLI is named for models it cannot run", async () => {
  const app = await open("./ModelPickerNoticesFixture.tsx", { width: 800, height: 700, platform: "macos" });
  await app.press("label:Select model");
  // The selected provider (Codex) is healthy: no setup, but its newer models need an update.
  await expect(app.shows("label:Open provider setup")).toBe(false);
  await expect(app.texts()).toContain("Update the Codex CLI to v0.9.0 or newer to use GPT-6 and GPT-6 Mini.");
  await expect(app.shows("label:Provider settings")).toBe(true);
  // A signed-out provider's own icon is not pressable (it is not ready); its setup shows on an empty Favorites list.
  await app.press("label:Favorites");
  await expect(app.texts()).toContain("Claude is not signed in.");
  await expect(app.shows("label:Open provider setup")).toBe(true);
  // The Codex notice belongs to Codex.
  await expect(app.texts()).not.toContain("Update the Codex CLI to v0.9.0 or newer to use GPT-6 and GPT-6 Mini.");
  await app.press("label:Open provider setup");
  await app.waitFor("text:setup claudeAgent");
});

test("searching shows the update notice of every provider whose models match, and no setup offer", async () => {
  const app = await open("./ModelPickerNoticesFixture.tsx", { width: 800, height: 700, platform: "macos" });
  await app.press("label:Select model");
  await app.press("label:Favorites");
  await expect(app.shows("label:Open provider setup")).toBe(true);
  await app.type("label:Search models", "gpt-6");
  await expect(app.texts()).toContain("Update the Codex CLI to v0.9.0 or newer to use GPT-6 and GPT-6 Mini.");
  await expect(app.shows("label:Open provider setup")).toBe(false);
});
