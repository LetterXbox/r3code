// The panel is built once: an update of the panel's state (opening a tab, a terminal taking the focus) or of the
// workspace must not build it again. Built again, every web view in it was a new native web view; a terminal's web view
// that had just become first responder by a click was removed, and nothing could be typed anywhere (RightPanel.tsx
// `sheetShown`, workspace/host-focus/results.md). The docked cases are in webViewIdentity.test.tsx; this is the
// narrow-layout sheet, whose condition reads the panel state that every panel update notifies.
import { expect, open, test } from "nsh/test";

type App = Awaited<ReturnType<typeof open>>;

function mounts(app: App): Record<string, number> {
  const line = app.texts().find((text) => text.startsWith("webviews:")) ?? "webviews:{}";
  return JSON.parse(line.slice("webviews:".length)) as Record<string, number>;
}

test("in the narrow-layout sheet, opening another tab does not make the browser's web view again", async () => {
  const app = await open("./WebViewIdentityFixture.tsx", { width: 900, height: 800, platform: "macos" });
  await app.press("label:Fixture toggle panel");
  await app.press("label:Browser");
  await app.waitFor("label:Search or enter URL");
  await app.type("label:Search or enter URL", "http://127.0.0.1:9/a");
  await app.submit("label:Search or enter URL");
  await app.waitUntil(() => Object.keys(mounts(app)).some((key) => key.startsWith("preview:")));
  const key = Object.keys(mounts(app)).find((name) => name.startsWith("preview:"))!;
  expect(mounts(app)[key]).toBe(1);
  await app.press("label:Add panel surface");
  await app.press("label:Add Files");
  await app.waitFor("label:Close Files");
  await app.wait(100);
  expect(mounts(app)[key]).toBe(1);
});

test("switching between the docked panel and the narrow-layout sheet keeps the browser's web view, both ways", async () => {
  const app = await open("./WebViewIdentityFixture.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.press("label:Fixture toggle panel");
  await app.press("label:Browser");
  await app.waitFor("label:Search or enter URL");
  await app.type("label:Search or enter URL", "http://127.0.0.1:9/a");
  await app.submit("label:Search or enter URL");
  await app.waitUntil(() => Object.keys(mounts(app)).some((key) => key.startsWith("preview:")));
  const key = Object.keys(mounts(app)).find((name) => name.startsWith("preview:"))!;
  expect(mounts(app)[key]).toBe(1);
  await app.setViewport(900, 800);
  await app.waitFor("label:Search or enter URL");
  await app.wait(150);
  expect(mounts(app)[key]).toBe(1);
  await app.setViewport(1280, 800);
  await app.waitFor("label:Search or enter URL");
  await app.wait(150);
  expect(mounts(app)[key]).toBe(1);
});

test("the sheet closes on a backdrop press and on Escape, and opening it again keeps the page", async () => {
  const app = await open("./WebViewIdentityFixture.tsx", { width: 900, height: 800, platform: "macos" });
  await app.press("label:Fixture toggle panel");
  await app.press("label:Browser");
  await app.waitFor("label:Search or enter URL");
  await app.type("label:Search or enter URL", "http://127.0.0.1:9/a");
  await app.submit("label:Search or enter URL");
  await app.waitUntil(() => Object.keys(mounts(app)).some((key) => key.startsWith("preview:")));
  const key = Object.keys(mounts(app)).find((name) => name.startsWith("preview:"))!;
  await app.press("label:Close right panel sheet");
  await app.wait(200);
  expect(await app.shows("label:Close right panel sheet")).toBe(false);
  await app.press("label:Fixture toggle panel");
  await app.waitFor("label:Close right panel sheet");
  await app.keyboard.press("escape");
  await app.wait(200);
  expect(await app.shows("label:Close right panel sheet")).toBe(false);
  await app.press("label:Fixture toggle panel");
  await app.waitFor("label:Search or enter URL");
  await app.wait(150);
  expect(mounts(app)[key]).toBe(1);
});

test("Escape in a menu open inside the sheet closes only the menu", async () => {
  const app = await open("./WebViewIdentityFixture.tsx", { width: 900, height: 800, platform: "macos" });
  await app.press("label:Fixture toggle panel");
  await app.waitFor("label:Close right panel sheet");
  await app.press("label:Files");
  await app.press("label:Add panel surface");
  await app.waitFor("label:Add Diff");
  await app.keyboard.press("escape");
  await app.wait(200);
  expect(await app.shows("label:Add Diff")).toBe(false);
  expect(await app.shows("label:Close right panel sheet")).toBe(true);
  await app.keyboard.press("escape");
  await app.wait(200);
  expect(await app.shows("label:Close right panel sheet")).toBe(false);
});
