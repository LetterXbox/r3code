import { expect, open, test } from "nsh/test";

test("a settings row reveals its inheritance mark while the pointer is anywhere on the row", async () => {
  const app = await open("./HoverStatesFixture.tsx", { width: 900, height: 600, platform: "macos" });
  await app.waitFor("text:mark hidden");
  await app.hover("text:The model new threads start with.");
  await app.waitFor("text:mark revealed");
  await app.hover("text:Elsewhere");
  await app.waitFor("text:mark hidden");
  await expect(app.texts()).not.toContain("mark revealed");
});
