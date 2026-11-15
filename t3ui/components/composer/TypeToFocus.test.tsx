import { expect, open, test } from "nsh/test";

test("a typing key with no input focused goes to the composer, with its shifted form", async () => {
  const app = await open("./TypeToFocusFixture.tsx", { width: 400, height: 300, platform: "macos" });
  await app.keyboard.press("h");
  await app.keyboard.press("shift+i");
  await app.keyboard.press("shift+1");
  await app.keyboard.press("space");
  await app.keyboard.press("shift+/");
  await app.waitUntil(() => app.texts().includes("draft:hI! ?"));
});

test("a focused text input keeps its own typing", async () => {
  const app = await open("./TypeToFocusFixture.tsx", { width: 400, height: 300, platform: "macos" });
  await app.type("label:Other field", "a");
  await app.waitUntil(() => app.texts().includes("other:a"));
  await expect(app.texts()).toContain("draft:");
});

test("nothing is redirected while an overlay owns the keyboard", async () => {
  const app = await open("./TypeToFocusFixture.tsx", { width: 400, height: 300, platform: "macos" });
  await app.press("label:Disable redirect");
  await app.keyboard.press("a");
  await app.wait(50);
  await expect(app.texts()).toContain("draft:");
});

test("the paste chord with no input focused sends the clipboard's text to the composer", async () => {
  const app = await open("./TypeToFocusFixture.tsx", { width: 400, height: 300, platform: "macos" });
  await app.press("label:Copy text");
  await app.keyboard.press("mod+v");
  await app.waitUntil(() => app.texts().includes("draft:pasted text"));
});

