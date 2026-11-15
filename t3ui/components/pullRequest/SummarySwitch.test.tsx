import { expect, open, test } from "nsh/test";

test("switching pull requests closes the previous description editor", async () => {
  const app = await open("./SummarySwitchFixture.tsx", { width: 600, height: 700 });
  await app.press("label:Edit description");
  await app.waitFor("label:Save");
  await app.press("label:Switch pull request");
  await app.waitFor("text:Description 2");
  expect(app.shows("label:Save")).toBe(false);
});

test("check fix and link actions are independent, and checks without links are disabled", async () => {
  const app = await open("./SummarySwitchFixture.tsx", { width: 600, height: 700 });
  await app.press("label:Checks section");
  await app.press("label:Fix Build");
  await app.waitFor("text:Actions: fix");
  await app.press("label:Check Build");
  await app.waitFor("text:Actions: fix,link");
  let error = "";
  try { await app.press("label:Check No link"); } catch (cause) { error = String(cause); }
  expect(error).toContain("disabled");
});
