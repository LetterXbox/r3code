import { expect, open, test } from "nsh/test";

test("a server-scoped switch patches the server and keeps the value the server returns", async () => {
  const app = await open("./SettingsControlsFixture.tsx", { width: 1100, height: 1400 });
  await app.press("label:Connect fixture");
  await expect(app.shows("id:Fast worktree checkout (off)")).toBe(true);
  await app.press("label:Fast worktree checkout");
  await expect(app.texts()).toContain('server.updateSettings {"fastWorktreeCheckout":true}');
  await expect(app.shows("id:Fast worktree checkout (on)")).toBe(true);
  await app.press("label:Accept change");
  await expect(app.shows("id:Fast worktree checkout (on)")).toBe(true);
});

test("a rejected server write reverts the switch and shows the error", async () => {
  const app = await open("./SettingsControlsFixture.tsx", { width: 1100, height: 1400 });
  await app.press("label:Connect fixture");
  await app.press("label:Fail writes");
  await app.press("label:Fast worktree checkout");
  await expect(app.shows("id:Fast worktree checkout (on)")).toBe(true);
  await app.press("label:Settle requests");
  await expect(app.shows("id:Fast worktree checkout (off)")).toBe(true);
  await expect(app.texts()).toContain("Settings are managed by your organization");
});

test("a server-scoped write while disconnected says so and changes nothing", async () => {
  const app = await open("./SettingsControlsFixture.tsx", { width: 1100, height: 1400 });
  // Fast checkout shows only for a server that honours it, so this uses Guest links.
  await expect(app.shows("label:Fast worktree checkout")).toBe(false);
  await app.press("label:Guest links");
  await expect(app.texts()).toContain("Connect an environment to change this setting.");
  await expect(app.shows("id:Guest links (off)")).toBe(true);
});

test("a select that the generator found no options for opens the reference's choices", async () => {
  const app = await open("./SettingsControlsFixture.tsx", { width: 1100, height: 1400 });
  await app.press("label:Show worktrees");
  await app.press("label:Advanced >> nth=0");
  await app.press("id:Worktree submodules = recursive");
  await expect(app.texts()).toContain("Top level only");
});

test("a worktree cleanup rule writes the storageCleanup rule, as the global Cleanup card does", async () => {
  const app = await open("./SettingsControlsFixture.tsx", { width: 1100, height: 2000 });
  await app.press("label:Connect fixture");
  await app.press("label:Show worktrees");
  await expect(app.texts()).not.toContain("Automatic worktree cleanup");
  await app.press("label:Delete merged worktrees");
  await expect(app.texts()).toContain('server.updateSettings {"storageCleanup":{"worktreeOnMerge":true}}');
});

test("a retention row turns on at 8 days and the settled and unchanged rows sit behind Advanced", async () => {
  const app = await open("./SettingsControlsFixture.tsx", { width: 1100, height: 2000 });
  await app.press("label:Connect fixture");
  await app.press("label:Show worktrees");
  await expect(app.texts()).not.toContain("Delete settled worktrees");
  await app.press("label:Delete inactive worktrees");
  await expect(app.texts()).toContain('server.updateSettings {"storageCleanup":{"worktreeAfterDays":8}}');
  await app.press("label:Advanced >> nth=1");
  await expect(app.texts()).toContain("Delete settled worktrees");
  await expect(app.texts()).toContain("Keep worktrees with local changes");
});

test("a changed value shows the reset mark and reset writes the shipped default", async () => {
  const app = await open("./SettingsControlsFixture.tsx", { width: 1100, height: 1400 });
  await app.press("label:Connect fixture");
  await expect(app.shows("label:Reset Fast worktree checkout to default")).toBe(false);
  await app.press("label:Fast worktree checkout");
  await app.press("label:Accept change");
  await app.press("label:Reset Fast worktree checkout to default");
  await expect(app.texts()).toContain('server.updateSettings {"fastWorktreeCheckout":false}');
});
