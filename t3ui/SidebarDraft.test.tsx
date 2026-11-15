import { expect, open, test } from "nsh/test";

/** Both lines of the draft, each shown in the composer's editor (a rich editor has no harness input value). */
const composerLines = (app: { spanStyle(selector: string): unknown }) => ["Keep this draft", "and its second line"].filter((line) => { try { app.spanStyle(`id:composer-prompt >> text:${line}`); return true; } catch { return false; } }).join("|");

test("a draft card previews text and undo restores its contents", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800, platform: "macos", clock: {} });
  await app.press("label:New thread");
  // Enter sends, as in the reference: a second line is Shift+Enter.
  await app.type("id:composer-prompt", "Keep this draft");
  await app.keyboard.press("shift+enter");
  await app.type("id:composer-prompt", "and its second line");
  await app.wait(300);
  await expect(app.shows("label:Unsent draft: Keep this draft")).toBe(true);
  await app.hover("label:Unsent draft: Keep this draft");
  await app.press("label:Discard draft");
  await expect(app.shows("label:Unsent draft: Keep this draft")).toBe(false);
  await expect(app.shows("label:Undo discard draft")).toBe(true);
  await app.press("label:Undo discard draft");
  await expect(app.shows("label:Unsent draft: Keep this draft")).toBe(true);
  await expect(composerLines(app)).toBe("Keep this draft|and its second line");
  await app.wait(300);
  const reopened = await open("./App.tsx", { width: 1280, height: 800, platform: "macos", storage: app.storage() });
  await reopened.wait(100);
  await expect(composerLines(reopened)).toBe("Keep this draft|and its second line");
});

test("the undo notice expires after the discard window", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800, platform: "macos", clock: {} });
  await app.press("label:New thread");
  await app.type("id:composer-prompt", "Discard this draft");
  await app.hover("label:Unsent draft: Discard this draft");
  await app.press("label:Discard draft");
  await expect(app.shows("label:Undo discard draft")).toBe(true);
  await app.wait(5001);
  await expect(app.shows("label:Undo discard draft")).toBe(false);
});
