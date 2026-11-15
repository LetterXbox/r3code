import { expect, open, test } from "nsh/test";
import { microphoneError, MICROPHONE_UNAVAILABLE } from "./MicrophoneTest";
import { MICROPHONE_PERMISSION_ERROR } from "./speech";

test("session errors read as the reference's microphone copy", () => {
  expect(microphoneError(null)).toBe(null);
  expect(microphoneError("not-allowed")).toBe(MICROPHONE_PERMISSION_ERROR);
  expect(microphoneError("audio-capture")).toBe("Could not record microphone audio. Try again.");
  expect(microphoneError("unavailable")).toBe(MICROPHONE_UNAVAILABLE);
  expect(microphoneError("network")).toBe("Could not access the microphone.");
});

test("the test opens the microphone, counts up to ten seconds, and ends with Done", async () => {
  const app = await open("./MicrophoneFixture.tsx", { width: 700, height: 400 });
  await expect(app.texts()).toContain("Test microphone");
  await app.press("label:Test microphone");
  await app.waitFor("text:Opening microphone…");
  await app.press("label:Mic starts");
  await app.waitFor("label:Recording time");
  await expect(app.texts()).toContain("0:00 / 0:10");
  await app.press("label:Stop recording");
  await app.waitFor("label:Done");
  await app.press("label:Done");
  await app.waitFor("text:Test microphone");
});

test("a denied microphone shows the reference's pill and offers Record again", async () => {
  const app = await open("./MicrophoneFixture.tsx", { width: 700, height: 400 });
  await app.press("label:Test microphone");
  await app.press("label:Mic starts");
  await app.press("label:Mic ends denied");
  await app.waitFor("text:Microphone access needed");
  await expect(app.shows(`label:${MICROPHONE_PERMISSION_ERROR}`)).toBe(true);
  await app.press("label:Dismiss voice input error");
  await app.waitFor("text:Test microphone");
});

test("without audio capture the test shows the reference's unavailable error", async () => {
  const app = await open("./Voice.test.fixture.tsx", { width: 700, height: 400 });
  await app.press("label:Test microphone");
  await app.waitFor("text:Voice input failed");
  await expect(app.shows(`label:${MICROPHONE_UNAVAILABLE}`)).toBe(true);
});

test("a finished recording plays back with its position, and Done discards it", async () => {
  const app = await open("./MicrophoneFixture.tsx", { width: 700, height: 400 });
  await app.press("label:Test microphone");
  await app.press("label:Mic starts");
  await app.press("label:Mic level");
  await app.waitFor("label:Recording time");
  await expect(app.count("label:Microphone input level")).toBe(1);
  await app.press("label:Stop recording");
  await app.waitFor("label:Play recording");
  await expect(app.shows("label:Recording playback position")).toBe(true);
  await app.press("label:Play recording");
  await app.waitFor("label:Pause recording");
  await expect(app.texts()).toContain("0:01");
  await app.press("label:Pause recording");
  await app.waitFor("label:Play recording");
  await app.press("label:Done");
  await app.waitFor("text:Test microphone");
});
