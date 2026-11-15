import { expect, open, test } from "nsh/test";

const line = (app: { texts(): string[] }, key: string) => { const found = app.texts().find((text) => text.startsWith(`${key}:`)); return found ? found.slice(key.length + 1) : null; };

test("a message typed in the side composer goes to the child thread; the parent's draft is untouched", async () => {
  const app = await open("./SideChatFixture.tsx", { width: 1200, height: 800, platform: "macos" });
  await expect(line(app, "retained")).toBe("1");
  await expect(app.texts()).toContain("Side question");
  await app.type("label:Side chat thread", "side hello");
  await app.waitUntil(() => line(app, "side-draft") === JSON.stringify("side hello"));
  await expect(line(app, "parent-draft")).toBe(JSON.stringify("parent draft"));
  await app.keyboard.press("enter");
  await app.waitUntil(() => (line(app, "sent") ?? "").includes("side hello"));
  await expect(JSON.parse(line(app, "sent")!)).toEqual([["message.dispatch", "thread:side", "side hello"]]);
  await app.waitUntil(() => line(app, "side-draft") === JSON.stringify(""));
  await expect(line(app, "parent-draft")).toBe(JSON.stringify("parent draft"));
});

test("Bring back merges the child's finished run into the parent; closing releases the subscription", async () => {
  const app = await open("./SideChatFixture.tsx", { width: 1200, height: 800, platform: "macos" });
  await app.press("label:Child reply finished");
  await app.press("label:Bring back");
  await app.waitUntil(() => (line(app, "sent") ?? "").includes("thread.merge_back"));
  await expect(JSON.parse(line(app, "sent")!)).toEqual([["thread.merge_back", "thread:side", null]]);
  await app.press("label:Close side chat");
  await app.waitUntil(() => app.texts().includes("pane closed"));
  await expect(line(app, "retained")).toBe("0");
});

test("the side chat shows and cancels its own queued message", async () => {
  const app = await open("./SideChatFixture.tsx", { width: 1200, height: 800, platform: "macos" });
  await app.press("label:Queue child message");
  await app.waitFor("text:queued for child");
  await app.press("label:Remove queued message");
  await app.waitUntil(() => (line(app, "sent") ?? "").includes("queued-run.cancel"));
  expect(JSON.parse(line(app, "sent")!)).toEqual([["queued-run.cancel", "thread:side", null]]);
});

test("an image in the side chat opens its preview", async () => {
  const app = await open("./SideChatFixture.tsx", { width: 1200, height: 800, platform: "macos" });
  await app.press("label:Show child image");
  await app.waitFor("label:Preview child.png");
  await app.press("label:Preview child.png");
  await app.waitFor("label:Close attachment preview");
  await app.press("label:Close attachment preview");
});
