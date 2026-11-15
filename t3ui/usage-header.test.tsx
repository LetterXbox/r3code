import { expect, open, test } from "nsh/test";

test("narrow usage header keeps its controls reachable", async () => {
  const app = await open("./App.tsx", { width: 760, height: 700 });
  await app.keyboard.press("mod+u");
  await app.waitFor("label:Usage metric");
  await app.press("label:Usage metric");
  await app.press("label:Select Cost");
  await app.waitFor("label:Usage period");
  await app.press("label:Usage period");
  await app.press("label:Select 7 days");
  expect(app.texts()).toContain("7 days");
  await app.press("label:Close");
  expect(app.texts()).not.toContain("Connect an environment to see usage.");
}, 90_000);
