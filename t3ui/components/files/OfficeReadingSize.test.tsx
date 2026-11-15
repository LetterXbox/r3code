import { expect, open, test } from "nsh/test";

test("a document reads at 100% and steps by a quarter between 50% and 200%", async () => {
  const app = await open("./ReadingSizeFixture.tsx", { width: 800, height: 600 });
  await app.waitFor("label:Increase reading size");
  await expect(app.texts()).toContain("100%");
  await app.press("label:Increase reading size");
  await app.waitFor("text:125%");
  await app.press("label:Reset reading size");
  await app.waitFor("text:100%");
  for (let i = 0; i < 2; i++) await app.press("label:Decrease reading size");
  await app.waitFor("text:50%");
});
