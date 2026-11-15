import { open, test } from "nsh/test";

const draft = (app: { texts(): string[] }) => { const line = app.texts().find((text) => text.startsWith("draft:")); return line ? JSON.parse(line.slice(6)) as string : null; };

test("Shift+Enter continues a list, an empty item leaves it, Tab nests and Shift+Tab lifts the item", async () => {
  const app = await open("./ComposerSkillFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "1. one");
  await app.waitUntil(() => draft(app) === "1. one");
  await app.keyboard.press("shift+enter");
  await app.waitUntil(() => draft(app) === "1. one\n2. ");
  await app.type("id:composer-prompt", "two");
  await app.waitUntil(() => draft(app) === "1. one\n2. two");
  await app.keyboard.press("tab");
  await app.waitUntil(() => draft(app) === "1. one\n   1. two");
  await app.keyboard.press("shift+tab");
  await app.waitUntil(() => draft(app) === "1. one\n2. two");
  await app.keyboard.press("shift+enter");
  await app.waitUntil(() => draft(app) === "1. one\n2. two\n3. ");
  await app.keyboard.press("shift+enter");
  await app.waitUntil(() => draft(app) === "1. one\n2. two\n");
});

test("Shift+Enter off a list still starts a new line", async () => {
  const app = await open("./ComposerSkillFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.type("id:composer-prompt", "plain");
  await app.waitUntil(() => draft(app) === "plain");
  await app.keyboard.press("shift+enter");
  await app.type("id:composer-prompt", "next");
  await app.waitUntil(() => draft(app) === "plain\nnext");
});
