import { expect, open, test } from "nsh/test";

test("one popup holds the search and the refs, with each ref's badge and the web's copy", async () => {
  const app = await open("./BranchFixture.tsx", { width: 600, height: 500, platform: "macos" });
  await app.waitUntil(() => app.texts().includes("main"));
  await app.press("label:Select branch");
  await expect(app.shows("label:Search refs")).toBe(true);
  await expect(app.texts()).toContain("current");
  await expect(app.texts()).toContain("remote");
  await app.type("label:Search refs", "zzz");
  await app.waitUntil(() => app.texts().includes("No refs found.") || app.texts().some((text) => text.startsWith("Create new ref")));
});

test("typing a name that does not exist offers Create new ref, which creates and switches", async () => {
  const app = await open("./BranchFixture.tsx", { width: 600, height: 500, platform: "macos" });
  await app.waitUntil(() => app.texts().includes("main"));
  await app.press("label:Select branch");
  await app.type("label:Search refs", "new work");
  await app.waitUntil(() => app.shows('label:Create new ref "new-work"'));
  await app.press('label:Create new ref "new-work"');
  await app.waitUntil(() => app.texts().includes("changed:new-work"));
  await expect(app.texts().some((text) => text.includes("vcs.createRef:new-work"))).toBe(true);
});

test("a pick shows at once, and a failed switch rolls the label back and says why", async () => {
  const app = await open("./BranchFixture.tsx", { width: 600, height: 500, platform: "macos" });
  await app.waitUntil(() => app.texts().includes("main"));
  await app.press("label:Select branch");
  await app.press("label:broken");
  await app.waitUntil(() => app.texts().includes("Your local changes would be overwritten."));
  await expect(app.texts()).toContain("main");
  await expect(app.texts()).toContain("changed:none");
});

test("a pick that succeeds reports the new branch to the thread", async () => {
  const app = await open("./BranchFixture.tsx", { width: 600, height: 500, platform: "macos" });
  await app.waitUntil(() => app.texts().includes("main"));
  await app.press("label:Select branch");
  await app.press("label:feature/queue");
  await app.waitUntil(() => app.texts().includes("changed:feature/queue"));
});
