import { expect, open, test } from "nsh/test";

test("while recording the footer keeps the model chip and the send button beside the pill", async () => {
  const app = await open("./VoiceRecordingFixture.tsx", { width: 900, height: 500, platform: "macos" });
  await app.waitFor("label:Finish voice input");
  expect(app.shows("label:Cancel voice input")).toBe(true);
  expect(app.shows("label:Select model")).toBe(true);
  expect(app.texts()).toContain("Hello");
  expect(app.texts()).toContain("0:00");
});
