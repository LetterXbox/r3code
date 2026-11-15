import { expect, open, test } from "nsh/test";

test("a row's stack mark reads the stack when opened and opens a layer; a stack that is gone says so", async () => {
  const app = await open("./StackPopoverFixture.tsx", { width: 600, height: 400 });
  await app.press("label:Stack 4, layer 1 of 2");
  await app.waitFor("text:This pull request is no longer in a stack.");
  await app.press("label:Stack 4, layer 1 of 2");
  await app.press("label:Stack 4, layer 1 of 2");
  await app.waitFor("label:Open #8");
  await app.press("label:Open #8");
  await app.waitFor("text:opened: 8");
  await expect(app.texts()).toContain("opened: 8");
});
