import { expect, open, test } from "nsh/test";

const draft = (app: { texts(): string[] }) => { const line = app.texts().find((text) => text.startsWith("draft:")); return line ? JSON.parse(line.slice(6)) as string : null; };
/** The editor's line, its tokens' icon glyphs (U+FF000...) and leading zero-width space left out. */
const editorLine = (app: { texts(): string[] }) => (app.texts()[1] ?? "").replace(/[\u200b\u{ff000}-\u{ff0ff}]/gu, "");

test("a skill picked from the $ menu sits inline as a token labelled council, never the raw $council", async () => {
  const app = await open("./ComposerSkillFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "use $cou");
  await app.waitFor("text:Ask the council");
  await app.keyboard.press("enter");
  await app.waitUntil(() => draft(app) === "use $council ");
  // The prompt text keeps `$council` (what the server receives); the editor shows the token's label.
  await expect(editorLine(app)).toBe("use council ");
  // The skill's cube icon is the token's first character, in the token's ink.
  await expect(app.texts()[1]).toBe("use \u{ff000}council ");
  await expect(app.texts().some((text) => !text.startsWith("draft:") && text.includes("$council"))).toBe(false);
  await expect(app.shows("text:Ask the council")).toBe(false);
  await expect(app.spanStyle("id:composer-prompt >> text:council").color).not.toBe(app.spanStyle("id:composer-prompt >> text:use").color);
  await app.keyboard.press("backspace");
  await app.waitUntil(() => draft(app) === "use $council");
  await app.keyboard.press("backspace");
  await app.waitUntil(() => draft(app) === "use ");
  await expect(editorLine(app)).toBe("use ");
});

test("typing a known skill followed by a space turns it into a token; an unknown one stays text", async () => {
  const app = await open("./ComposerSkillFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "$nope $council ");
  await app.keyboard.press("escape");
  await app.waitUntil(() => draft(app) === "$nope $council ");
  await expect(editorLine(app)).toBe("$nope council ");
});

test("a shortcut the server rebinds after the editor mounts still reaches the registry while the composer has the keyboard", async () => {
  const app = await open("./ComposerSkillFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "keep me");
  await app.press("label:Rebind sidebar");
  await app.wait(50);
  await app.type("id:composer-prompt", " too");
  await app.keyboard.press("mod+shift+e");
  await app.waitUntil(() => app.texts().includes("ran:sidebar"));
  await expect(draft(app)).toBe("keep me too");
});

test("an @ mention lists matching models; picking one puts the model inline as a token", async () => {
  const app = await open("./ComposerSkillFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "try @sol");
  await app.waitFor("text:GPT 6.1 Sol");
  await app.keyboard.press("enter");
  await app.waitUntil(() => draft(app) === "try model:codex/gpt-6.1-sol ");
  await expect(editorLine(app)).toBe("try GPT 6.1 Sol ");
});

test("select all then typing replaces the prompt, and undo brings it back", async () => {
  const app = await open("./ComposerSkillFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "old text");
  await app.keyboard.press("mod+a");
  await app.keyboard.press("x");
  await app.waitUntil(() => draft(app) === "x");
  // Edits within the history's group delay undo together, as typing does: 1000 ms, the reference's
  // COMPOSER_UNDO_GROUP_DELAY (composer-undo-grouping.ts), so the second edit waits past it.
  await app.wait(1300);
  await app.keyboard.press("mod+a");
  await app.keyboard.press("backspace");
  await app.waitUntil(() => draft(app) === "");
  await app.keyboard.press("mod+z");
  await app.waitUntil(() => draft(app) === "x");
  await app.keyboard.press("mod+shift+z");
  await app.waitUntil(() => draft(app) === "");
});

test("word deletion, selection and the clipboard chords stay the editor's", async () => {
  const app = await open("./ComposerSkillFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "one two");
  await app.keyboard.press("alt+backspace");
  await app.waitUntil(() => draft(app) === "one ");
  await app.keyboard.press("shift+left");
  await app.keyboard.press("shift+left");
  await app.keyboard.press("x");
  await app.waitUntil(() => draft(app) === "onx");
  // A paste of text goes in at the caret (mod+c / mod+x need the real clipboard: checked on screen).
  await app.paste("id:composer-prompt", { text: " $council " });
  await app.waitUntil(() => draft(app) === "onx $council ");
  await expect(app.texts()).toContain("ran:");
});
