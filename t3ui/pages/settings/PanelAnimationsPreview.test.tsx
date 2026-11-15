import { expect, open, test } from "nsh/test";
import { animateNextLayout } from "./PanelAnimationsPreview";

test("the preview animates the next layout only for a duration above zero", () => {
  expect(animateNextLayout(0)).toBe(false);
  expect(animateNextLayout(200)).toBe(true);
});

test("pressing the preview opens and closes its panels, with or without a duration", async () => {
  const app = await open("./PanelAnimationsPreviewFixture.tsx", { width: 400, height: 300, platform: "macos" });
  expect(app.shows("id:Preview sidebar")).toBe(true);
  await app.press("label:Replay panel animation preview");
  await app.wait(400);
  await app.press("text:Instant");
  await app.press("label:Replay panel animation preview");
  await app.press("label:Replay panel animation preview");
  expect(app.shows("id:Panel animation preview")).toBe(true);
});
