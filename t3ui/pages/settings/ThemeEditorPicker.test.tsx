import { expect, open, test } from "nsh/test";

test("Escape cancels the color picker while leaving the editor open", async () => {
  const app = await open("./ThemeEditorPickerFixture.tsx", { width: 1000, height: 800 });
  await app.waitFor("label:Background hex value");
  const original = app.value("label:Background hex value");
  await app.press("label:Choose Background color");
  await app.waitFor("label:Background picker hex value");
  await app.clear("label:Background picker hex value");
  await app.type("label:Background picker hex value", "#aabbcc");
  await app.submit("label:Background picker hex value");
  await app.waitUntil(() => app.value("label:Background hex value") !== original);
  await app.keyboard.press("escape");
  await app.wait(150);
  expect(app.value("label:Background hex value")).toBe(original);
  expect(app.shows("label:Background hex value")).toBe(true);
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("label:Background hex value"));
});
