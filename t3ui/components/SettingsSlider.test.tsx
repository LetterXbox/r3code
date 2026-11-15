import { expect, open, test } from "nsh/test";

test("dragging the settings slider updates its value", async () => {
  const app = await open("./SettingsSliderFixture.tsx", { width: 500, height: 200 });
  await app.waitFor("label:Contrast");
  await app.drag("label:Contrast", { x: 35 });
  await app.waitUntil(() => !app.shows("text:value:100"));
  const result = app.texts().find((text) => /^value:\d+$/.test(text));
  const value = Number(result?.slice("value:".length));
  expect(value > 100).toBe(true);
  expect(value % 5).toBe(0);
});
