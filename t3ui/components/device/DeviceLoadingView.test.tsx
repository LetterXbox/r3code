import { expect, open, test } from "nsh/test";
import { loadingStepLabel } from "./DeviceLoadingView";

test("the step bar names the stage", () => {
  expect(loadingStepLabel("opening")).toBe("Step 1 of 2: open device");
  expect(loadingStepLabel("stream")).toBe("Step 2 of 2: connect video");
});

test("an opening view shows name, description, message and the step bar; an error view drops the bar", async () => {
  const app = await open("./DeviceLoadingViewFixture.tsx", { width: 500, height: 700, platform: "macos" });
  await app.waitFor("text:Starting device…");
  await expect(app.shows("text:iPhone 15")).toBe(true);
  await expect(app.shows("text:This machine · 17.2")).toBe(true);
  await expect(app.shows("label:Step 1 of 2: open device")).toBe(true);
  await expect(app.shows("text:Stream failed.")).toBe(true);
  await expect(app.shows("text:Reconnect")).toBe(true);
  await expect(app.shows("label:Step 2 of 2: connect video")).toBe(false);
});
