import { expect, open, test } from "nsh/test";

test("cost tab paints the headline, provider shares, totals and the model breakdown", async () => {
  const app = await open("./UsageFixture.tsx", { width: 1280, height: 900 });
  const shown = app.texts();
  await expect(shown).toContain("$5.00");
  await expect(shown).toContain("3 sessions · API estimate");
  await expect(shown).toContain("Claude Code");
  await expect(shown).toContain("70.0% of cost · 8K tokens");
  await expect(shown).toContain("Totals");
  await expect(shown).toContain("Cache savings");
  await expect(shown).toContain("Cost by type");
  await expect(shown).toContain("claude-sonnet");
  await app.press("label:Day");
  await expect(app.texts()).toContain("Nov 11");
});

test("limits tab paints remaining quota and the reset countdown", async () => {
  const app = await open("./UsageFixture.tsx", { width: 1280, height: 900 });
  await app.press("label:Show limits");
  await expect(app.texts()).toContain("62%");
  await expect(app.texts()).toContain("left");
  await expect(app.texts()).toContain("↻ 2h 5m");
  await expect(app.texts()).toContain("Session (5h)");
});

test("provider menu filters the page and relabels its trigger", async () => {
  const app = await open("./UsageFixture.tsx", { width: 1280, height: 900 });
  await expect(app.texts()).toContain("All providers");
  await app.press("label:Usage providers");
  await app.press("label:Codex");
  await expect(app.texts()).toContain("Claude Code");
  await expect(app.texts()).toContain("$3.50");
  await expect(app.texts()).not.toContain("gpt-test");
  // The preference is stored under the app id the owner's window also uses: leave nothing hidden behind ("7 providers").
  await app.press("label:Codex");
  await expect(app.texts()).toContain("All providers");
});

test("a model row opens the per-model dialog with its stats", async () => {
  const app = await open("./UsageFixture.tsx", { width: 1280, height: 900 });
  await app.press("label:Model claude-sonnet");
  await expect(app.texts()).toContain("Per 1M tokens");
  await expect(app.texts()).toContain("Cache hit");
  await expect(app.texts()).toContain("Tokens by type");
});

test("the price editor lists custom prices and adds a row", async () => {
  const app = await open("./UsageFixture.tsx", { width: 1280, height: 900 });
  await app.press("label:Open prices");
  await expect(app.texts()).toContain("Custom model prices");
  await expect(app.texts()).toContain("No custom prices or mappings. Add a row to set one.");
  await app.press("label:Add model price");
  await expect(app.texts()).toContain("Save changes");
  await expect(app.texts()).toContain("USD / million tokens");
  await expect(app.shows("label:Input price for new model")).toBe(true);
});

test("a limit window carries a pace icon labelled like the web's, not a text badge", async () => {
  const app = await open("./UsageFixture.tsx", { width: 1280, height: 900 });
  await app.press("label:Show limits");
  await app.waitFor("label:Under pace: headroom left for the rest of the window");
  await expect(app.texts()).not.toContain("Under pace");
});

test("fast service adds a Cost by speed bar with its premium", async () => {
  const app = await open("./UsageFixture.tsx", { width: 1280, height: 900 });
  await expect(app.texts()).toContain("Cost by speed");
  await expect(app.texts()).toContain("Premium $0.25");
  await expect(app.texts()).toContain("Fast");
});

const CLAUDE_SEGMENT = "label:Claude: 62% left, resets in 2h 5m, 42% of the window left, 2 reset credits banked";

test("banked reset credits sit on the segment and redeem from its popover only after the shared confirmation", async () => {
  const app = await open("./UsageFixture.tsx", { width: 1280, height: 900 });
  await app.press("label:Show limits");
  await expect(app.shows("label:Use reset for Claude")).toBe(false);
  await app.press(CLAUDE_SEGMENT);
  await expect(app.texts()).toContain("2 banked · expires in 3h 0m");
  await app.press("label:Use reset for Claude");
  await expect(app.texts()).toContain("Use a reset credit?");
  await app.press("label:Cancel");
  await expect(app.texts()).not.toContain("Use a reset credit?");
  await app.press(CLAUDE_SEGMENT);
  await app.press("label:Use reset for Claude");
  await app.press("label:Confirm");
  await app.waitFor("text:Reset applied. Your windows have cleared.");
});

test("two accounts of one provider share a bar with a segment each, a hatched refill and the accounts' details", async () => {
  const app = await open("./UsageFixture.tsx", { width: 1400, height: 1000 });
  await app.press("label:Pool two accounts");
  await app.press("label:Show limits");
  // Both sessions pool into one card of two segments; the weekly-spent account's refill is hatched.
  await expect(app.texts()).toContain("Claude Two");
  await expect(app.shows("label:Refill pattern")).toBe(true);
  await app.press("label:Claude Two: 40% left, resets in 1h 0m, 20% of the window left");
  await expect(app.texts()).toContain("Signed in");
  await expect(app.texts()).toContain("Fixture host");
  await expect(app.shows("label:Toggle account email visibility")).toBe(true);
});

test("an account whose limits could not be read becomes one amber notice, not a bar", async () => {
  const app = await open("./UsageFixture.tsx", { width: 1400, height: 1000 });
  await app.press("label:Pool two accounts");
  await app.press("label:Show limits");
  await expect(app.texts()).toContain("Grok: Could not read limits.");
});

test("the external usage link opens its page", async () => {
  const app = await open("./UsageFixture.tsx", { width: 1280, height: 900 });
  await app.press("label:Show limits");
  await expect(app.texts()).toContain("View usage in ChatGPT with your connected account.");
  await app.press("label:Manage usage");
  await app.waitFor("text:https://chatgpt.com/#settings/Usage");
});

test("Escape closes the Usage modal, a menu inside it first", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+u");
  await app.waitFor("text:Connect an environment to see limits.");
  await app.press("label:Usage providers");
  await app.waitFor("label:All providers");
  await app.keyboard.press("escape");
  await app.wait(100);
  await expect(app.shows("label:Codex")).toBe(false);
  await expect(app.texts()).toContain("Connect an environment to see limits.");
  await app.keyboard.press("escape");
  await app.wait(150);
  await expect(app.texts()).not.toContain("Connect an environment to see limits.");
  await expect(app.shows("id:composer-prompt")).toBe(false);
});

test("Escape closes the price editor before the page", async () => {
  const app = await open("./UsageFixture.tsx", { width: 1280, height: 900 });
  await app.press("label:Open prices");
  await expect(app.texts()).toContain("Custom model prices");
  await app.keyboard.press("escape");
  await app.wait(100);
  await expect(app.texts()).not.toContain("Custom model prices");
});

test("hub accounts join the pool: an e-mail names a merged account, a hub-only account says where it was read, and a hub redeems its own credit", async () => {
  const app = await open("./UsageFixture.tsx", { width: 1400, height: 1000 });
  await app.press("label:Add hub accounts");
  await app.press("label:Show limits");
  // Ada signs in through the provider and is also on Hub One: one account, named by the hub's e-mail, not "Claude".
  await expect(app.shows("label:Account AE")).toBe(true);
  await expect(app.texts()).toContain("zed");
  await app.press("label:zed: 90% left, resets in 3h 0m, 60% of the window left");
  await expect(app.texts()).toContain("Via");
  await expect(app.texts()).toContain("Hub One");
  // The credit is banked on the hub, so its redemption names the source, account and credit.
  await app.press("label:AE: 0% left, resets in 20h 0m, 1 reset credit banked");
  await app.press("label:Use reset for AE");
  await app.press("label:Confirm");
  await app.waitFor('text:sent provider.consumeResetCredit {"sourceId":"hub1","accountId":"ada.json","creditId":"cr1"}');
});

test("a hub that failed or reported no accounts is one notice each, named by its label", async () => {
  const app = await open("./UsageFixture.tsx", { width: 1400, height: 1000 });
  await app.press("label:Add hub accounts");
  await app.press("label:Show limits");
  await expect(app.texts()).toContain("Hub Two: Management key rejected.");
  await expect(app.texts()).toContain("Hub Three: No accounts reported.");
  await expect(app.texts()).toContain("Grok: Could not read limits.");
});

test("with several environments a differing rate reads Mixed, and an edit writes only the cells that were edited to each environment", async () => {
  const app = await open("./UsageFixture.tsx", { width: 1400, height: 1000 });
  await app.press("label:Add saved environments");
  await app.press("label:Open prices");
  await app.waitFor("text:gpt-x");
  // The live connection charges 3 for output and Build box 2; the read-only box has no row for it, which differs too.
  await app.press("label:Apply to All environments");
  await expect(app.texts()).toContain("Read-only access");
  await app.press("label:Locked box");
  await app.press("label:Apply to 2 environments");
  await expect(app.shows("label:Apply to 2 environments")).toBe(true);
  await app.type("label:Input price for gpt-x", "2");
  await expect(app.texts()).toContain("Changes apply to 2 environments");
  await app.press("label:Save changes");
  await app.waitFor("text:Build box");
  await app.waitFor('text:sent saved-1 server.updateSettings {"patch":{"usagePriceOverrides":{"gpt-x":{"inputCostPerMillionTokens":12,"outputCostPerMillionTokens":2}}}}');
  await app.waitFor('text:sent ws://test.invalid/ws server.updateSettings {"patch":{"usagePriceOverrides":{"gpt-x":{"inputCostPerMillionTokens":12,"outputCostPerMillionTokens":3}}}}');
  await app.waitFor("text:Saved");
});

test("a save that fails on one environment says so there, and Retry failed saves sends only that one again", async () => {
  const app = await open("./UsageFixture.tsx", { width: 1400, height: 1000 });
  await app.press("label:Add saved environments");
  await app.press("label:Fail Build box saves");
  await app.press("label:Open prices");
  await app.waitFor("text:gpt-x");
  await app.press("label:Apply to All environments");
  await app.press("label:Locked box");
  await app.type("label:Input price for gpt-x", "2");
  await app.press("label:Save changes");
  await app.waitFor("text:Not saved · Could not save. Try again.");
  await expect(app.shows("label:Retry failed saves")).toBe(true);
  await expect(app.shows("label:Discard pending changes")).toBe(true);
  await app.press("label:Fail Build box saves");
  await app.press("label:Retry failed saves");
  await app.waitUntil(() => !app.texts().includes("Not saved · Could not save. Try again."));
  await expect(app.shows("label:Retry failed saves")).toBe(false);
});

test("a read-only environment that is the only one selected refuses the save with its reason", async () => {
  const app = await open("./UsageFixture.tsx", { width: 1400, height: 1000 });
  await app.press("label:Add saved environments");
  await app.press("label:Open prices");
  await app.waitFor("text:gpt-x");
  await app.press("label:Apply to All environments");
  await app.press("label:This device");
  await app.press("label:Build box");
  await app.press("label:Add model price");
  await app.type("label:New model ID", "fresh");
  await app.type("label:Input price for new model", "1");
  await app.type("label:Output price for new model", "2");
  await app.press("label:Save changes");
  await app.waitFor("text:Not saved · Read-only access");
});

test("a mapped model shows Counted as, and a model that maps to itself is refused", async () => {
  const app = await open("./UsageFixture.tsx", { width: 1400, height: 1000 });
  await app.press("label:Open prices");
  await app.press("label:Add model price");
  await app.type("label:New model ID", "gpt-y");
  await app.type("label:Map new model to model", "gpt-x");
  await expect(app.texts()).toContain("Counted as gpt-x");
  await app.clear("label:Map new model to model");
  await app.type("label:Map new model to model", "gpt-y");
  await app.waitFor("text:Map to a different model.");
});

// usageCache.ts: the shared cache behind the page. UsageCacheFixture.tsx answers server.getUsageSummary with a
// strictly higher cost on every real call, so a refetch the test did not expect shows up as the number changing.
test("reopening the Usage page paints the cached cost instantly, without asking the server again", async () => {
  const app = await open("./UsageCacheFixture.tsx", { width: 1280, height: 900 });
  await app.keyboard.press("mod+u");
  await app.press("label:Cost");
  await app.waitFor("text:$1.00");
  await app.keyboard.press("escape");
  await app.wait(100);
  await app.keyboard.press("mod+u");
  await app.wait(150);
  await expect(app.texts()).toContain("$1.00");
  await expect(app.texts()).not.toContain("$2.00");
});

test("switching Cost and Tokens never refetches: the same payload is shown both times", async () => {
  const app = await open("./UsageCacheFixture.tsx", { width: 1280, height: 900 });
  await app.keyboard.press("mod+u");
  await app.press("label:Cost");
  await app.waitFor("text:$1.00");
  await app.press("label:Tokens");
  await app.wait(150);
  await app.press("label:Cost");
  await app.wait(150);
  await expect(app.texts()).toContain("$1.00");
  await expect(app.texts()).not.toContain("$2.00");
});

test("Refresh asks the server again and the new answer replaces the cached one", async () => {
  const app = await open("./UsageCacheFixture.tsx", { width: 1280, height: 900 });
  await app.keyboard.press("mod+u");
  await app.waitFor("label:Cost");
  await app.press("label:Cost");
  await app.waitFor("text:$1.00");
  await app.press("label:Refresh usage");
  await app.waitFor("text:$2.00");
});

test("the breakdown carries the reference's labels (fm13)", async () => {
  const app = await open("./UsageFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("label:Usage breakdown");
  await app.press("label:Day");
  await app.waitFor("label:Usage breakdown by time");
});
