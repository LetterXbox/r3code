import { expect, open, test } from "nsh/test";

/** The composer's draft as the store holds it (the fixture prints it; a rich editor has no input value). */
const draft = (app: { texts(): string[] }) => { const line = app.texts().find((text) => text.startsWith("draft:")); return line ? JSON.parse(line.slice(6)) as string : null; };

test("send shortcut controls whether Enter inserts a line break", async () => {
  const app = await open("./ComposerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "First");
  await app.keyboard.press("enter");
  await expect(draft(app)).toBe("First");

  await app.press("label:Use modified Enter");
  await app.type("id:composer-prompt", " line");
  await app.keyboard.press("enter");
  await app.waitUntil(() => draft(app) === "First line\n");
  for (const key of ["shift+s", "e", "c", "o", "n", "d"]) await app.keyboard.press(key);
  await app.waitUntil(() => draft(app) === "First line\nSecond");
  await app.keyboard.press("mod+enter");
  await expect(draft(app)).toBe("First line\nSecond");

  await app.press("label:Use modified Enter for multiline");
  await app.type("id:composer-prompt", " third");
  await app.keyboard.press("enter");
  await app.waitUntil(() => draft(app) === "First line\nSecond third\n");
  for (const key of ["shift+f", "o", "u", "r", "t", "h"]) await app.keyboard.press(key);
  // A plain letter arrives through the input method and reaches the draft on a later turn (no key handler to flush it).
  await app.waitUntil(() => draft(app) === "First line\nSecond third\nFourth");
});


test("typing a slash opens the command menu; Enter picks the command and Escape dismisses it", async () => {
  const app = await open("./ComposerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "/mo");
  await app.waitUntil(() => app.texts().includes("Switch response model for this thread"));
  await expect(app.texts()).toContain("/model");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.texts().includes("Switch response model for this thread"));
  await expect(draft(app)).toBe("/mo");
});

test("Enter in the command menu runs the highlighted command instead of sending", async () => {
  const app = await open("./ComposerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "/mo");
  await app.waitUntil(() => app.texts().includes("/model"));
  await app.keyboard.press("enter");
  await app.waitUntil(() => draft(app) === "");
  await expect(app.texts()).not.toContain("Switch response model for this thread");
});

test("an at mention with no workspace shows the empty state", async () => {
  const app = await open("./ComposerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "look @sr");
  await app.waitUntil(() => app.texts().includes("No matching files or folders."));
});

test("Up with no earlier messages leaves the draft alone", async () => {
  const app = await open("./ComposerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "draft");
  await app.keyboard.press("up");
  await expect(draft(app)).toBe("draft");
});

test("the branch toolbar under the card names the checkout and the ref with the web copy", async () => {
  const app = await open("./ComposerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await expect(app.texts()).toContain("Current checkout");
  await expect(app.texts()).toContain("Select ref");
  await expect(app.shows("label:Workspace")).toBe(true);
  await expect(app.shows("label:Select branch")).toBe(true);
});

test("the footer bar offers attach and a disabled send until there is a draft", async () => {
  const app = await open("./ComposerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await expect(app.shows("label:Attachments unavailable")).toBe(true);
  await expect(app.enabled("label:Submit message")).toBe(false);
  await app.type("id:composer-prompt", "hello");
  await expect(app.shows("label:Submit message")).toBe(true);
});

test("dollar opens the skills menu and hash the pull request menu, each with the web's empty copy", async () => {
  const app = await open("./ComposerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "use $re");
  await app.waitUntil(() => app.texts().includes("No skills found. Try / to browse provider commands."));
  await app.keyboard.press("escape");
  await app.type("id:composer-prompt", " and #12");
  // useComposerMenuItems.ts:410-412: with a query the empty line names it ("No pull request matches 12.").
  await app.waitUntil(() => app.texts().includes("No pull request matches 12."));
});

test("idle offers only the Submit message action, never Stop, Resume or Queue", async () => {
  const app = await open("./ComposerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await expect(app.shows("label:Submit message")).toBe(true);
  await expect(app.shows("label:Stop generation")).toBe(false);
  await expect(app.shows("label:Resume thread")).toBe(false);
  await expect(app.shows("label:Queue message")).toBe(false);
});

test("mod+s stashes the prompt and clears the composer; mod+s on an empty composer restores the only entry", async () => {
  const app = await open("./ComposerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "stash me");
  await app.keyboard.press("mod+s");
  await app.waitUntil(() => app.shows("label:Stashed prompts: 1. Open stash."));
  await app.waitUntil(() => draft(app) === "");
  await app.keyboard.press("mod+s");
  await app.waitUntil(() => draft(app) === "stash me");
  await expect(app.shows("label:Stashed prompts: 1. Open stash.")).toBe(false);
});

test("with several stashed prompts the badge opens the stash menu, and picking a row restores it", async () => {
  const app = await open("./ComposerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "first prompt");
  await app.keyboard.press("mod+s");
  // The draft starts as "", so wait for the stash itself: the composer clears only once the stash write resolved.
  await app.waitUntil(() => app.shows("label:Stashed prompts: 1. Open stash."));
  await app.waitUntil(() => draft(app) === "");
  await app.type("id:composer-prompt", "second prompt");
  await app.keyboard.press("mod+s");
  await app.waitUntil(() => app.shows("label:Stashed prompts: 2. Open stash."));
  await app.press("label:Stashed prompts: 2. Open stash.");
  await expect(app.shows("label:Close stash")).toBe(true);
  await expect(app.shows("label:Restore stashed prompt: first prompt")).toBe(true);
  await app.press("label:Restore stashed prompt: first prompt");
  await app.waitUntil(() => draft(app) === "first prompt");
  await expect(app.shows("label:Close stash")).toBe(false);
});

test("the slash menu lists /side and /btw with the reason they cannot start yet", async () => {
  const app = await open("./ComposerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "/s");
  await app.waitUntil(() => app.texts().includes("/side"));
  await expect(app.texts()).toContain("Side chats are not ready yet. Try again in a moment.");
  await expect(app.texts()).not.toContain("/clear");
});

test("the dictation control is the web's microphone button", async () => {
  const app = await open("./ComposerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await expect(app.shows("label:Start voice input")).toBe(true);
});

test("composer.branch (mod+shift+g) opens the branch picker", async () => {
  const app = await open("./ComposerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.keyboard.press("mod+shift+g");
  await app.waitUntil(() => app.shows("label:Search refs"));
});

test("the empty composer shows the reference placeholder and a new thread's strip names the permissions", async () => {
  const app = await open("./ComposerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await expect(app.texts().map((text) => text.replace(/^\u200b/, ""))).toContain("Ask anything. @ files, $ skills, / commands");
  await expect(app.shows("label:Permissions: Full access")).toBe(true);
});

const heightOf = (app: { texts(): string[] }) => { const line = app.texts().find((text) => text.startsWith("height:")); return line ? Number(line.slice(7)) : 0; };

test("the empty composer is as tall as the reference card (pt-4, two lines, pb-2, the 32pt footer row, pb-2)", async () => {
  const app = await open("./ComposerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.waitUntil(() => heightOf(app) > 0);
  await expect(Math.abs(heightOf(app) - 111) <= 1.5).toBe(true);
});

test("files dropped on the thread's sidebar row are taken once by its composer and staged through the normal intake", async () => {
  const { pendingFileDrop } = await import("../sidebar/pendingFileDrop");
  const { openThread } = await import("../../store");
  const app = await open("./ComposerFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.press("label:Drop files on thread");
  // Not connected here, so the intake says why it cannot attach: proof the composer took the drop and tried.
  await app.waitUntil(() => app.texts().includes("Attachments are unavailable for this environment."));
  await expect(pendingFileDrop(openThread()?.id ?? "")).toBe(null);
});
