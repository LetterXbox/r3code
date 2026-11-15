import { expect, open, test } from "nsh/test";

test("a linked thread notification resolves its subagent using the scoped parent", async () => {
  const app = await open("./NoticeScopeFixture.tsx", { width: 900, height: 400 });
  await expect(app.texts()).toContain("Shield Pickups");
  await expect(app.texts()).toContain("Finished the work");
  await expect(app.texts()).not.toContain("Generic notice");
});
