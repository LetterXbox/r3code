import { expect, open, test } from "nsh/test";

test("the draft hero picker pins a project from its row and with the thread pin shortcut", async () => {
  const app = await open("./DraftHeroPinFixture.tsx", { width: 1100, height: 700 });
  await app.press("label:Choose project");
  await app.waitFor("label:Pin Beta");
  await app.press("label:Pin Beta");
  await app.waitFor("text:calls projects.mutate:p1:true");
  await app.keyboard.press("mod+shift+p");
  await app.waitFor("text:calls projects.mutate:p1:true,projects.mutate:p0:true");
});
