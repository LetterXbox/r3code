// A WebView element made again is a new native web view: its page reloads and loses its scroll position, form input
// and history. These count how often each one is made (webViewMounts.ts) across the actions that must not remake it.
import { expect, open, test } from "nsh/test";
import { webViewLive } from "../terminal/webviewLive";

const size = { width: 1280, height: 800, platform: "macos" } as const;
// The Ghostty terminal is a WebView page; the headless engine never loads it, so the drawer
// never gets a mounted terminal webview to track. Only runs under a real window
// (components/terminal/webviewLive.ts).
const live = await webViewLive();
const windowed = live ? test : test.skip;
type App = Awaited<ReturnType<typeof open>>;
const BROWSER = "preview:browser:1";

function mounts(app: App): Record<string, number> {
  const line = app.texts().find((text) => text.startsWith("webviews:")) ?? "webviews:{}";
  return JSON.parse(line.slice("webviews:".length)) as Record<string, number>;
}

/** Lets pending region runs and the deferred mount counts land, then reads the counts. */
async function settled(app: App): Promise<Record<string, number>> {
  await app.wait(80);
  return mounts(app);
}

async function browserOpen(): Promise<App> {
  const app = await open("./WebViewIdentityFixture.tsx", size);
  await app.press("label:Fixture toggle panel");
  await app.press("label:Browser");
  await app.waitFor("label:Search or enter URL");
  await app.type("label:Search or enter URL", "http://127.0.0.1:9/a");
  await app.submit("label:Search or enter URL");
  await app.waitUntil(() => mounts(app)[BROWSER] === 1);
  return app;
}

test("a resize commit keeps the browser's web view", async () => {
  const app = await browserOpen();
  await app.waitFor("text:panel-width:540");
  await app.drag("label:Resize right panel", { x: -100 });
  await app.waitFor("text:panel-width:640");
  await app.drag("label:Resize right panel", { x: 60 });
  await app.waitFor("text:panel-width:580");
  await expect((await settled(app))[BROWSER]).toBe(1);
});

test("a held drag neither hides nor replaces the page", async () => {
  const app = await browserOpen();
  await app.waitFor("text:panel-width:540");
  await app.dragAndHold("label:Resize right panel", { x: -100 });
  // While the drag is on, the page is neither hidden nor swapped for a placeholder: it is the same view, resized by the
  // panel's width (the headless pointer does not move during a hold, so the width itself is checked after the drop).
  await expect(app.shows("label:Resizing panel")).toBe(true);
  await expect(app.shows("label:Browser page hidden behind an open menu")).toBe(false);
  await expect(app.shows("label:Search or enter URL")).toBe(true);
  await app.drop();
  await app.waitFor("text:panel-width:640");
  await expect((await settled(app))[BROWSER]).toBe(1);
});

test("switching to another tab and back keeps each tab's page", async () => {
  const app = await browserOpen();
  await app.press("label:Add panel surface");
  await app.press("label:Add Files");
  await app.waitFor("label:Select Files");
  await expect(app.shows("label:Search or enter URL")).toBe(false);
  await app.press("label:Select 127.0.0.1:9");
  await app.waitFor("label:Search or enter URL");
  await expect((await settled(app))[BROWSER]).toBe(1);
});

test("a new address navigates the same web view", async () => {
  const app = await browserOpen();
  await app.press("label:Go to page b");
  await app.waitUntil(() => app.value("label:Search or enter URL") === "http://127.0.0.1:9/b");
  await expect((await settled(app))[BROWSER]).toBe(1);
});

test("maximising and restoring the panel keeps the page", async () => {
  const app = await browserOpen();
  await app.press("label:Maximize panel");
  await app.waitFor("label:Resize right panel", { state: "gone" });
  await app.waitFor("label:Restore panel size");
  await app.press("label:Restore panel size");
  await app.waitFor("label:Resize right panel");
  await expect((await settled(app))[BROWSER]).toBe(1);
});

test("closing the panel and opening it again keeps the page", async () => {
  const app = await browserOpen();
  await app.press("label:Fixture toggle panel");
  await app.waitFor("label:Search or enter URL", { state: "gone" });
  await expect(app.shows("label:Right panel tabs")).toBe(false);
  await app.press("label:Fixture toggle panel");
  await app.waitFor("label:Search or enter URL");
  await expect((await settled(app))[BROWSER]).toBe(1);
});

test("another thread has its own page, and coming back finds the first thread's page as it was", async () => {
  const app = await browserOpen();
  await app.press("label:Show thread 2");
  await app.waitFor("text:thread:fixture-thread-2");
  // Thread 2 has no panel yet: thread 1's page is hidden, not on screen.
  await expect(app.shows("label:Search or enter URL")).toBe(false);
  await app.press("label:Fixture toggle panel");
  await app.press("label:Browser");
  await app.waitFor("label:Search or enter URL");
  await expect(app.value("label:Search or enter URL")).toBe("");
  await app.press("label:Show thread 1");
  await app.waitFor("text:thread:fixture-thread-1");
  await app.waitUntil(() => app.value("label:Search or enter URL") === "http://127.0.0.1:9/a");
  // Thread 2's empty tab made no web view, and thread 1's was made once.
  await expect((await settled(app))[BROWSER]).toBe(1);
});

test("web views above the surface: an overlay hides the page behind a placeholder and gives the same web view back", async () => {
  const app = await browserOpen();
  await app.press("label:Open overlay");
  await app.waitFor("label:Browser page hidden behind an open menu");
  await app.press("label:Close overlay");
  await app.waitFor("label:Browser page hidden behind an open menu", { state: "gone" });
  await app.press("label:Open settings");
  await app.waitFor("label:Browser page hidden behind an open menu");
  await app.press("label:Close settings");
  await app.waitFor("label:Browser page hidden behind an open menu", { state: "gone" });
  await expect((await settled(app))[BROWSER]).toBe(1);
});

test("web views under the surface: no overlay hides, replaces or remakes the page", async () => {
  const app = await browserOpen();
  await app.press("label:Web views under surface");
  await app.press("label:Open overlay");
  await app.waitFor("text:overlay:true");
  await expect(app.shows("label:Browser page hidden behind an open menu")).toBe(false);
  await app.press("label:Close overlay");
  await app.press("label:Open settings");
  await app.wait(50);
  await expect(app.shows("label:Browser page hidden behind an open menu")).toBe(false);
  await app.press("label:Close settings");
  await app.press("label:Add panel surface");
  await app.waitFor("label:Add Terminal");
  await expect(app.shows("label:Browser page hidden behind an open menu")).toBe(false);
  await app.keyboard.press("escape");
  await expect((await settled(app))[BROWSER]).toBe(1);
});

test("a terminal tab's web view survives a resize, a tab switch, a split beside it and the panel closing", async () => {
  const app = await open("./WebViewIdentityFixture.tsx", size);
  await app.press("label:Fixture toggle panel");
  await app.press("label:Terminal");
  await app.waitFor("label:Terminal tab");
  await app.waitUntil(() => Object.keys(mounts(app)).some((key) => key.startsWith("terminal:panel:")));
  const key = Object.keys(mounts(app)).find((name) => name.startsWith("terminal:panel:"))!;
  await app.drag("label:Resize right panel", { x: -60 });
  await app.waitFor("text:panel-width:600");
  await app.press("label:Add panel surface");
  await app.press("label:Add Files");
  await app.waitFor("label:Select Files");
  await app.press("label:Fixture split panel terminal");
  await app.waitUntil(() => Object.keys(mounts(app)).filter((name) => name.startsWith("terminal:panel:")).length === 2);
  await app.press("label:Fixture toggle panel");
  await app.waitFor("label:Right panel tabs", { state: "gone" });
  await app.press("label:Fixture toggle panel");
  await app.waitFor("label:Right panel tabs");
  const after = await settled(app);
  await expect(after[key]).toBe(1);
  await expect(Object.entries(after).filter(([name]) => name.startsWith("terminal:panel:")).map(([, count]) => count)).toEqual([1, 1]);
});

windowed("the drawer's terminal survives a drawer state update (a height commit, a terminal taking the focus)", async () => {
  const app = await open("./WebViewIdentityFixture.tsx", size);
  await app.press("label:Fixture toggle drawer");
  await app.waitFor("label:Terminal drawer");
  await app.waitUntil(() => Object.keys(mounts(app)).some((key) => key.startsWith("terminal:fixture-thread-1:")));
  await app.press("label:Commit drawer height");
  await app.press("label:Commit drawer height");
  await app.drag("label:Resize terminal drawer", { y: -40 });
  const after = await settled(app);
  await expect(Object.entries(after).filter(([name]) => name.startsWith("terminal:fixture-thread-1:")).map(([, count]) => count)).toEqual([1]);
});
