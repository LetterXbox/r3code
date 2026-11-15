import { expect, open, test } from "nsh/test";

test("the pill shows nothing idle, then recording controls with the live transcript, and finishing inserts it", async () => {
  const app = await open("./VoiceInputPillFixture.tsx", { width: 800, height: 400, platform: "macos" });
  expect(app.texts().includes("Preparing")).toBe(false);
  await app.press("label:Begin");
  await app.waitUntil(() => app.texts().includes("Preparing"));
  await app.press("label:Listening");
  await app.waitUntil(() => app.shows("label:Finish voice input"));
  await app.press("label:Hear");
  await app.waitUntil(() => app.texts().includes("hello"));
  await app.press("label:Finish voice input");
  await app.waitUntil(() => app.texts().includes("inserted:hello world"));
});

test("an error shows the reference's short label with dismiss and record again", async () => {
  const app = await open("./VoiceInputPillFixture.tsx", { width: 800, height: 400, platform: "macos" });
  await app.press("label:Begin");
  await app.press("label:Listening");
  await app.press("label:Fail");
  await app.waitUntil(() => app.texts().includes("No speech detected"));
  expect(app.shows("label:Record again")).toBe(true);
  await app.press("label:Dismiss voice input error");
  await app.waitUntil(() => !app.texts().includes("No speech detected"));
});
