import { expect, open, test } from "nsh/test";

test("step one offers the language's model with the reference copy, and downloading moves to Ready to dictate", async () => {
  const app = await open("./VoiceInputSetupFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.press("label:Open setup");
  await app.waitUntil(() => app.shows("text:"+"Parakeet Unified English 0.6B"));
  const has = (text: string) => app.shows(`text:${text}`);
  expect(has("Set up voice input")).toBe(true);
  expect(has("Transcribe speech on OzBook M3 and use voice input across environments.")).toBe(true);
  expect(has("Recommended for English")).toBe(true);
  expect(has("Download the 696 MB model to OzBook M3. Microphone audio is sent there for transcription, as chosen in Voice settings.")).toBe(true);
  expect(has("Silero (1.2 MB), used for silence filtering and pause detection, downloads alongside the speech model. An installed copy is reused.")).toBe(true);
  expect(app.shows("label:Choose another model or language")).toBe(true);
  await app.press("label:Download model");
  await app.waitUntil(() => app.shows("text:"+"Speak and transcribe in multiple languages or translate into English, and get names and technical terms right with the dictionary in Voice settings."));
  expect(app.shows("label:Customize in Voice settings")).toBe(true);
  await app.press("label:Start dictating");
  await app.waitUntil(() => app.shows("text:started:1"));
  expect(app.shows("label:Start dictating")).toBe(false);
});

test("Escape closes the dialog", async () => {
  const app = await open("./VoiceInputSetupFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.press("label:Open setup");
  await app.waitUntil(() => app.shows("label:Download model"));
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("label:Download model"));
});
