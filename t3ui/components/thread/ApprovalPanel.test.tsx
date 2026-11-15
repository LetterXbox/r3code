import { expect, open, test } from "nsh/test";

test("approval requires visible details and can retry a failed response", async () => {
  const app = await open("./ApprovalFixture.tsx", { width: 800, height: 600 });
  await expect(app.texts()).toContain("npm test");
  // An approval with an empty prompt still renders (kind label) and stays answerable.
  await expect(app.shows("label:Approve edit")).toBe(true);
  await expect(app.shows("label:File change approval")).toBe(true);
  await expect(app.texts()).toContain("Waiting for approval");
  await expect(app.shows("label:Command approval")).toBe(true);
  await expect(app.shows("label:More approval options")).toBe(true);
  await expect(app.count("label:Approve")).toBe(1);
  await app.press("label:Approve");
  await expect(app.enabled("label:Approve")).toBe(false);
  await app.press("label:Toggle approval panel");
  await app.press("label:Toggle approval panel");
  await expect(app.enabled("label:Approve")).toBe(false);
  await app.press("label:Fail response");
  await app.waitFor("text:Connection lost");
  await expect(app.enabled("label:Approve")).toBe(true);
  await app.press("label:Approve");
  await app.press("label:Resolve response");
  await app.waitUntil(() => app.count("label:Approve") === 0);
});

test("the decisions beyond decline and approve wait behind More", async () => {
  const app = await open("./ApprovalFixture.tsx", { width: 800, height: 600 });
  await expect(app.shows("label:Always allow this session")).toBe(false);
  await app.press("label:More approval options");
  await app.press("label:Always allow this session");
  await expect(app.enabled("label:Approve")).toBe(false);
});

test("a request the provider can no longer answer shows why, its app and the full-access question, with no actions", async () => {
  const app = await open("./ApprovalFixture.tsx", { width: 800, height: 600 });
  await app.press("label:Show gone approval");
  await expect(app.texts()).toContain("Provider process is gone. Interrupt or restart the run to respond.");
  await expect(app.texts()).toContain("Figma");
  await expect(app.shows("label:Why am I being asked this?")).toBe(true);
  await expect(app.shows("label:Approve gone")).toBe(false);
  await expect(app.texts()).not.toContain("Waiting for approval");
});

test("the full-access question opens its explanation on press", async () => {
  const app = await open("./ApprovalFixture.tsx", { width: 800, height: 600 });
  await app.press("label:Show gone approval");
  await app.press("text:Why am I being asked this?");
  await app.waitFor("text:Full access skips approvals, but an ask rule in the agent's own settings matches this action, so it still asks. Remove or narrow that rule to stop these prompts.");
});
