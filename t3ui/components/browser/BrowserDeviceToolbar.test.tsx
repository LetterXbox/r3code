import { expect, open, test } from "nsh/test";

const size = { width: 900, height: 300, platform: "macos" as const };

test("fm13: the Dimensions caption and wide preset trigger follow the toolbar width", async () => {
  const app = await open("./BrowserDeviceToolbarFixture.tsx", size);
  await app.waitFor("text:Dimensions");
  await app.press("label:Narrow");
  await app.waitUntil(() => !app.shows("text:Dimensions"));
});

test("fm13: Enter commits a typed size; rotate turns an uncommitted typed size", async () => {
  const app = await open("./BrowserDeviceToolbarFixture.tsx", size);
  await app.clear("label:Viewport width");
  await app.type("label:Viewport width", "500");
  await app.submit("label:Viewport width");
  await app.waitFor("text:committed 500x300 ratio none commits 1");
  await app.clear("label:Viewport height");
  await app.type("label:Viewport height", "400");
  await app.press("label:Rotate viewport");
  await app.waitFor("text:committed 400x500 ratio none commits 2");
});

test("fm13: with the ratio locked the other side follows and the lock has its tooltip", async () => {
  const app = await open("./BrowserDeviceToolbarFixture.tsx", size);
  await app.hover("label:Lock viewport aspect ratio");
  await app.waitFor("text:Lock aspect ratio");
  await app.press("label:Lock viewport aspect ratio");
  await app.waitFor("text:committed 600x300 ratio 2.00 commits 1");
  await app.clear("label:Viewport width");
  await app.type("label:Viewport width", "800");
  await app.waitUntil(() => app.value("label:Viewport height") === "400");
  await app.submit("label:Viewport width");
  await app.waitFor("text:committed 800x400 ratio 2.00 commits 2");
});

test("fm13: tabbing from width to height keeps editing; leaving the toolbar commits", async () => {
  const app = await open("./BrowserDeviceToolbarFixture.tsx", size);
  await app.clear("label:Viewport width");
  await app.type("label:Viewport width", "500");
  await app.keyboard.press("tab");
  await app.wait(100);
  expect(app.texts()).toContain("committed 600x300 ratio none commits 0");
  await app.keyboard.press("tab");
  await app.waitFor("text:committed 500x300 ratio none commits 1");
});
