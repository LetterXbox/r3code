import { expect, open, test } from "nsh/test";

test("the image viewer zooms with + and -, toggles with Enter and resets with 0 (ZoomableImage keys)", async () => {
  const app = await open("./ExpandedMediaFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.press("label:Open image");
  await app.waitFor("text:100%");
  await app.keyboard.press("plus");
  await app.waitFor("text:150%");
  await app.keyboard.press("minus");
  await app.waitFor("text:100%");
  await app.keyboard.press("enter");
  await app.waitFor("text:200%");
  await app.keyboard.press("0");
  await app.waitFor("text:100%");
  await expect(app.texts()).toContain("100%");
});

test("a click on the image toggles fit and 2x; a drag of the zoomed image pans without zooming (ZoomableImage pointer)", async () => {
  const app = await open("./ExpandedMediaFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.press("label:Open image");
  await app.waitFor("text:100%");
  await app.press("id:zoomable-image");
  await app.waitFor("text:200%");
  await app.drag("id:zoomable-image", { x: -60, y: -40 });
  await app.wait(50);
  await expect(app.texts()).toContain("200%");
  // Past the double-click interval, so the next press is a single click.
  await app.wait(700);
  await app.press("id:zoomable-image");
  await app.waitFor("text:100%");
});

test("a resized window refits a zoomed image (ZoomableImage viewer size)", async () => {
  const app = await open("./ExpandedMediaFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.press("label:Open image");
  await app.keyboard.press("enter");
  await app.waitFor("text:200%");
  await app.setViewport(1000, 760);
  await app.waitFor("text:100%");
});
