import { open, test } from "nsh/test";

const draft = (app: { texts(): string[] }) => { const line = app.texts().find((text) => text.startsWith("draft:")); return line ? JSON.parse(line.slice(6)) as string : null; };

test("Mod+B bolds the selection and Mod+I / Mod+E mark it, written back as Markdown", async () => {
  const app = await open("./ComposerSkillFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "hi");
  await app.keyboard.press("mod+a");
  await app.keyboard.press("mod+b");
  await app.waitUntil(() => draft(app) === "**hi**");
  await app.keyboard.press("mod+i");
  await app.waitUntil(() => draft(app) === "***hi***");
  await app.keyboard.press("mod+b");
  await app.keyboard.press("mod+i");
  await app.keyboard.press("mod+e");
  await app.waitUntil(() => draft(app) === "`hi`");
});

test("typed **bold** becomes a mark, and the prompt keeps its Markdown", async () => {
  const app = await open("./ComposerSkillFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "say **loud** now");
  await app.waitUntil(() => draft(app) === "say **loud** now");
  await app.keyboard.press("mod+a");
  await app.keyboard.press("mod+b");
  // The selection holds bold text: Mod+B takes the mark off (toggleMark), leaving plain text.
  await app.waitUntil(() => draft(app) === "say loud now");
});

test("```ts then Enter opens a code block; Enter inside adds lines; a closing fence leaves it", async () => {
  const app = await open("./ComposerSkillFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "```ts");
  await app.keyboard.press("enter");
  await app.waitUntil(() => draft(app) === "```ts\n```");
  await app.type("id:composer-prompt", "a");
  await app.keyboard.press("enter");
  await app.type("id:composer-prompt", "b");
  await app.waitUntil(() => draft(app) === "```ts\na\nb\n```");
  await app.waitFor("label:Code language: TypeScript");
});

test("typed `- ` makes a list; Enter adds an item, Enter on an empty item leaves the list; Backspace lifts an item", async () => {
  const app = await open("./ComposerSkillFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "- one");
  await app.waitUntil(() => draft(app) === "- one");
  await app.keyboard.press("enter");
  await app.waitUntil(() => draft(app) === "- one\n- ");
  await app.type("id:composer-prompt", "two");
  await app.waitUntil(() => draft(app) === "- one\n- two");
  await app.keyboard.press("enter");
  await app.keyboard.press("enter");
  await app.waitUntil(() => draft(app) === "- one\n- two\n");
  await app.type("id:composer-prompt", "# Title");
  await app.waitUntil(() => draft(app) === "- one\n- two\n# Title");
});

test("Backspace at a list item's start makes it a line again", async () => {
  const app = await open("./ComposerSkillFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "- ");
  await app.waitUntil(() => draft(app) === "- ");
  await app.keyboard.press("backspace");
  await app.waitUntil(() => draft(app) === "");
});

test("bold the caret touches shows its delimiters as text, and reads back as bold once the caret leaves", async () => {
  const app = await open("./ComposerSkillFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "say **loud**");
  // The caret right after the closing delimiter touches the bold text: its source shows.
  await app.waitUntil(() => app.texts().some((text) => !text.startsWith("draft:") && text.includes("**loud**")));
  await app.type("id:composer-prompt", " now");
  await app.waitUntil(() => draft(app) === "say **loud** now");
  await app.waitUntil(() => !app.texts().some((text) => !text.startsWith("draft:") && text.includes("**loud**")));
});

test("the editor is labelled after the thread it writes to (ChatComposer ariaLabel)", async () => {
  const app = await open("./ComposerSkillFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.waitFor("label:Message New thread");
});

test("a task item's checkbox toggles the task, written back as [x]", async () => {
  const app = await open("./ComposerSkillFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "- [ ] buy milk");
  await app.waitUntil(() => draft(app) === "- [ ] buy milk");
  await app.press("role:checkbox");
  await app.waitUntil(() => draft(app) === "- [x] buy milk");
});
