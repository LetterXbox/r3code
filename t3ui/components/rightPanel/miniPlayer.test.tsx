// The floating browser preview through the right panel: how it is entered and left, that the page's web view is the
// same one in the panel and in the card (webViewMounts.ts counts each one made), and what a thread switch does.
import { expect, open, test } from "nsh/test";

const size = { width: 1280, height: 800, platform: "macos" } as const;
type App = Awaited<ReturnType<typeof open>>;
const BROWSER = "preview:browser:1";
const CARD = "label:Floating browser preview";

function line(app: App, name: string): string {
  return (app.texts().find((text) => text.startsWith(`${name}:`)) ?? `${name}:null`).slice(name.length + 1);
}
const mounts = (app: App) => JSON.parse(line(app, "webviews") === "null" ? "{}" : line(app, "webviews")) as Record<string, number>;
const mini = (app: App) => JSON.parse(line(app, "mini")) as { tabId: string; position: { x: number; y: number } | null; width: number | null; lastInteraction: string } | null;
const panel = (app: App) => JSON.parse(line(app, "panel")) as { open: boolean; active: string | null };

async function settled(app: App): Promise<Record<string, number>> {
  await app.wait(80);
  return mounts(app);
}

async function browserOpen(): Promise<App> {
  const app = await open("./MiniPlayerFixture.tsx", size);
  await app.press("label:Fixture toggle panel");
  await app.press("label:Browser");
  await app.waitFor("label:Search or enter URL");
  await app.type("label:Search or enter URL", "http://127.0.0.1:9/a");
  await app.submit("label:Search or enter URL");
  await app.waitUntil(() => mounts(app)[BROWSER] === 1);
  return app;
}

async function floated(): Promise<App> {
  const app = await browserOpen();
  await app.press("label:Fixture toggle panel");
  await app.waitFor(CARD);
  return app;
}

test("closing the panel with a browser tab in front floats that tab; the web view is the same one", async () => {
  const app = await browserOpen();
  await expect(app.shows(CARD)).toBe(false);
  await app.press("label:Fixture toggle panel");
  await app.waitFor(CARD);
  await expect(panel(app).open).toBe(false);
  await expect(mini(app)).toEqual({ tabId: "browser:1", position: null, width: null, lastInteraction: "drag" });
  // The card is the page alone: no address field, and the toolbar's three buttons.
  await expect(app.shows("label:Search or enter URL")).toBe(false);
  await expect(app.shows("label:Open preview in right panel")).toBe(true);
  await expect(app.shows("label:Pop preview into separate window")).toBe(true);
  await expect(app.enabled("label:Pop preview into separate window")).toBe(false);
  await expect(app.shows("label:Close floating preview")).toBe(true);
  await expect((await settled(app))[BROWSER]).toBe(1);
});

test("Open in right panel docks the same web view again, in front", async () => {
  const app = await floated();
  await app.press("label:Open preview in right panel");
  await app.waitFor("label:Search or enter URL");
  await expect(app.shows(CARD)).toBe(false);
  await expect(panel(app)).toEqual({ open: true, active: "browser:1" });
  await expect(mini(app)).toBe(null);
  await expect((await settled(app))[BROWSER]).toBe(1);
  // And out and in once more.
  await app.press("label:Fixture toggle panel");
  await app.waitFor(CARD);
  await app.press("label:Open preview in right panel");
  await app.waitFor("label:Search or enter URL");
  await expect((await settled(app))[BROWSER]).toBe(1);
});

test("Close floating preview hides the card and keeps the tab and its page", async () => {
  const app = await floated();
  await app.press("label:Close floating preview");
  await app.waitFor(CARD, { state: "gone" });
  await expect(mini(app)).toBe(null);
  await expect(panel(app).open).toBe(false);
  // The tab is still in the panel, with the page it had.
  await app.press("label:Fixture toggle panel");
  await app.waitFor("label:Search or enter URL");
  await expect(app.value("label:Search or enter URL")).toBe("http://127.0.0.1:9/a");
  await expect((await settled(app))[BROWSER]).toBe(1);
});

test("the toolbar's float button floats the tab and closes the panel; pressed again while docked it stops floating", async () => {
  const app = await browserOpen();
  await app.press("label:Float preview over chat");
  await app.waitFor(CARD);
  await expect(panel(app).open).toBe(false);
  // Back in the panel the tab is still the thread's floating tab: its button reads Close floating preview.
  await app.press("label:Fixture toggle panel");
  await app.waitFor("label:Search or enter URL");
  await expect(app.shows(CARD)).toBe(false);
  await expect(mini(app)?.tabId).toBe("browser:1");
  await app.press("label:Close floating preview");
  await expect(mini(app)).toBe(null);
  await app.waitFor("label:Float preview over chat");
  // No longer the floating tab: closing the panel by its sheet or the preview toggle floats it again (closePreviewPanel).
  await app.press("label:Fixture toggle preview");
  await app.waitFor(CARD);
  await expect((await settled(app))[BROWSER]).toBe(1);
});

test("with the panel open on another tab the floating tab shows beside it; selecting it docks it", async () => {
  const app = await floated();
  await app.press("label:Fixture toggle panel");
  await app.waitFor("label:Search or enter URL");
  await app.press("label:Add panel surface");
  await app.press("label:Add Files");
  await app.waitFor("label:Select Files");
  // Files is in front: the browser floats over the chat while the panel is open.
  await app.waitFor(CARD);
  await expect(panel(app)).toEqual({ open: true, active: "files" });
  await app.press("label:Select 127.0.0.1:9");
  await app.waitFor("label:Search or enter URL");
  await expect(app.shows(CARD)).toBe(false);
  await expect((await settled(app))[BROWSER]).toBe(1);
});

test("a second browser tab floated takes the card over; closing the floating tab's tab ends the float", async () => {
  const app = await floated();
  await app.press("label:Fixture toggle panel");
  await app.waitFor("label:Search or enter URL");
  await app.press("label:Add panel surface");
  await app.press("label:Add Browser");
  await app.waitUntil(() => panel(app).active === "browser:2");
  await app.type("label:Search or enter URL", "http://127.0.0.1:9/second");
  await app.submit("label:Search or enter URL");
  await app.waitUntil(() => mounts(app)["preview:browser:2"] === 1);
  // browser:1 floats beside the panel that shows browser:2.
  await app.waitFor(CARD);
  await expect(mini(app)?.tabId).toBe("browser:1");
  // Closing the panel floats the tab in front instead: one card per thread.
  await app.press("label:Fixture toggle panel");
  await app.waitUntil(() => mini(app)?.tabId === "browser:2");
  await expect(app.count(CARD)).toBe(1);
  const counts = await settled(app);
  await expect(counts[BROWSER]).toBe(1);
  await expect(counts["preview:browser:2"]).toBe(1);
  // The floating tab's tab is closed from the panel: nothing floats.
  await app.press("label:Fixture toggle panel");
  await app.waitFor("label:Search or enter URL");
  await app.press("label:Fixture close active tab");
  await app.waitUntil(() => mini(app) === null);
});

test("a thread switch hides the card and coming back shows it where it was, with the same web view", async () => {
  const app = await floated();
  await app.drag("id:Floating preview grip", { x: -200, y: -150 });
  await app.waitUntil(() => mini(app)?.position !== null);
  const place = mini(app)!.position;
  await app.press("label:Show thread 2");
  await app.waitFor("text:thread:mini-thread-2");
  await expect(app.shows(CARD)).toBe(false);
  await expect(mini(app)).toBe(null);
  await app.press("label:Show thread 1");
  await app.waitFor(CARD);
  await expect(mini(app)?.position).toEqual(place);
  await expect((await settled(app))[BROWSER]).toBe(1);
});

test("dragging the grip moves the card and dragging a handle resizes it at the page's proportions", async () => {
  const app = await floated();
  // Default: 320 x 200 (a 1280 x 800 page when its size in the panel is unknown), bottom right of the 700 x 700 canvas.
  await app.drag("id:Floating preview grip", { x: -100, y: -200 });
  await app.waitUntil(() => mini(app)?.position !== null);
  await expect(mini(app)?.lastInteraction).toBe("drag");
  const moved = mini(app)!.position!;
  await expect(moved.x < 700 - 12 - 320).toBe(true);
  await app.drag("id:Resize floating preview southeast", { x: -60, y: -40 });
  await app.waitUntil(() => mini(app)?.lastInteraction === "resize");
  const resized = mini(app)!;
  await expect(resized.width !== null && resized.width < 320 && resized.width >= 240).toBe(true);
  await expect((await settled(app))[BROWSER]).toBe(1);
});

test("on a host that draws web views above the app the card has a strip with the toolbar, and the same web view", async () => {
  const app = await browserOpen();
  await app.press("label:Web views above surface");
  await app.press("label:Fixture toggle panel");
  await app.waitFor(CARD);
  await expect(app.shows("label:Open preview in right panel")).toBe(true);
  await expect(app.shows("label:Close floating preview")).toBe(true);
  await app.drag("id:Floating preview grip", { x: -120, y: -100 });
  await app.waitUntil(() => mini(app)?.position !== null);
  await app.press("label:Open preview in right panel");
  await app.waitFor("label:Search or enter URL");
  await expect((await settled(app))[BROWSER]).toBe(1);
});

test("a tab with no page yet does not float", async () => {
  const app = await open("./MiniPlayerFixture.tsx", size);
  await app.press("label:Fixture toggle panel");
  await app.press("label:Browser");
  await app.waitFor("label:Search or enter URL");
  await app.press("label:Fixture toggle panel");
  await app.wait(80);
  await expect(mini(app)).toBe(null);
  await expect(app.shows(CARD)).toBe(false);
});

test("a floating device stream: its own card with the stream view, no pop-out, and Open in right panel opens its device tab", async () => {
  const app = await open("./MiniPlayerFixture.tsx", size);
  await app.press("label:Float a device");
  await app.waitFor("label:Floating device preview");
  // The stream view's own state: no environment address in a headless run, so it says so instead of a video.
  await app.waitFor("text:The environment address is not available.");
  expect(await app.shows("label:Pop preview into separate window")).toBe(false);
  await app.press("label:Open preview in right panel");
  await app.wait(100);
  expect(await app.shows("label:Floating device preview")).toBe(false);
  expect(panel(app)).toEqual({ open: true, active: "device:local:sim-1" });
});

test("closing the panel with a device tab in front floats its stream (floatDeviceSurface, before any device snapshot)", async () => {
  const app = await open("./MiniPlayerFixture.tsx", size);
  await app.press("label:Float a device");
  await app.waitFor("label:Floating device preview");
  await app.press("label:Open preview in right panel");
  await app.wait(100);
  await app.press("label:Fixture close panel");
  await app.waitFor("label:Floating device preview");
  expect(mini(app)?.tabId).toBe("device:local:sim-1");
});
