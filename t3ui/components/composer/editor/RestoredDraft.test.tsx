import { expect, open, test } from "nsh/test";

const sends = (app: { texts(): string[] }) => Number((app.texts().find((text) => text.startsWith("sends:")) ?? "sends:-1").slice(6));
const draft = (app: { texts(): string[] }) => { const line = app.texts().find((text) => text.startsWith("draft:")); return line ? JSON.parse(line.slice(6)) as string : null; };
const RESTORED = "# Plan\n- first\n- second\n- [ ] task\n```ts\nconst a = 1\n```\nlast line";

test("a restored rich draft (heading, list, task, code block) on a connected composer never sends by itself", async () => {
  const app = await open("./RestoredDraftFixture.tsx", { width: 900, height: 600, platform: "macos" });
  await app.waitFor("id:composer-prompt");
  await app.wait(3000);
  expect(sends(app)).toBe(0);
  expect(draft(app)).toBe(RESTORED);
  // Typing into it (the caret lands in the heading) still sends nothing.
  await app.type("id:composer-prompt", "x");
  await app.wait(1000);
  expect(sends(app)).toBe(0);
});

test("the send counter is live: the primary button sends once", async () => {
  const app = await open("./RestoredDraftFixture.tsx", { width: 900, height: 600, platform: "macos" });
  await app.press("label:Submit message");
  await app.waitUntil(() => sends(app) === 1);
});

test("finishing or cancelling a recording over that draft sends nothing", async () => {
  const app = await open("./RestoredDraftFixture.tsx", { width: 900, height: 600, platform: "macos" });
  await app.press("label:Finish voice input");
  await app.wait(1000);
  expect(sends(app)).toBe(0);
});
