// A layout switch fed by a thread object must not remount its child (the composer) on every server update:
// a focused RichEditor removed from the tree leaves its key bindings behind (workspace/nsh-runtime-bugs.md).
import { expect, open, test } from "nsh/test";

test("the child mounts once across many updates and again only after the branch flips", async () => {
  const app = await open("./SettledLayoutFixture.tsx");
  await app.waitFor("text:mounts=1");
  for (let i = 0; i < 6; i += 1) await app.press("label:Update");
  await expect(app.texts()).toContain("mounts=1");
  await app.press("label:Clear");
  await app.waitFor("text:empty");
  await app.press("label:Update");
  await app.waitFor("text:mounts=2");
  await expect(app.texts()).toContain("child");
});
