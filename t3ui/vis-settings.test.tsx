import { open, test } from "nsh/test";
test("settings general", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.wait(100);
  await app.press("text:General");
  await app.wait(150);
  await app.screenshot("t3ui/vis-general.png");
});
test("settings appearance", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.wait(100);
  await app.press("text:Appearance");
  await app.wait(150);
  await app.screenshot("t3ui/vis-appearance.png");
});
