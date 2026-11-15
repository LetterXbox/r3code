import { expect, open, test } from "nsh/test";

const options = { width: 400, height: 500, platform: "macos" as const };

async function searching() {
  const app = await open("./SearchSelectionFixture.tsx", options);
  await app.type("label:Search threads", "Alpha");
  return app;
}

test("Enter opens the first result when nothing was moved", async () => {
  const app = await searching();
  await app.submit("label:Search threads");
  await expect(app.texts()).toContain("Opened: one");
});

test("Down moves the highlight and Enter opens that result", async () => {
  const app = await searching();
  await expect(app.shows("label:Open search result Alpha one")).toBe(true);
  await app.keyboard.press("down");
  await app.keyboard.press("down");
  await app.submit("label:Search threads");
  await expect(app.texts()).toContain("Opened: three");
});

test("Up wraps from the first result to the last", async () => {
  const app = await searching();
  await app.keyboard.press("up");
  await app.submit("label:Search threads");
  await expect(app.texts()).toContain("Opened: three");
});

test("Escape clears the search", async () => {
  const app = await searching();
  await app.keyboard.press("escape");
  await expect(app.value("label:Search threads")).toBe("");
  await expect(app.shows("label:Open search result Alpha one")).toBe(false);
});

test("hovering a result moves the highlight to it", async () => {
  const app = await searching();
  await app.hover("label:Open search result Alpha two");
  await app.submit("label:Search threads");
  await expect(app.texts()).toContain("Opened: two");
});
