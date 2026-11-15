import { expect, open, test } from "nsh/test";

test("a scoped page names its scope, and a project scope shows and writes that project's overrides", async () => {
  const app = await open("./ScopeFixture.tsx", { width: 1100, height: 1400 });
  await expect(app.texts()).toContain("Applying settings for");
  await expect(app.texts()).toContain("across");
  await expect(app.shows("label:Project scope: All projects")).toBe(true);
  await expect(app.shows("label:Environment scope: All environments")).toBe(true);
  await expect(app.shows("id:Start new worktrees from remote by default (off)")).toBe(true);
  await app.press("label:Project scope: All projects");
  await app.press("label:legion");
  await expect(app.shows("label:Project scope: legion")).toBe(true);
  // The project overrides it on, so the page shows the override and a reset-to-inherited mark.
  await expect(app.shows("id:Start new worktrees from remote by default (on)")).toBe(true);
  await expect(app.shows("label:Reset Start from remote to default")).toBe(true);
  await app.press("label:Start new worktrees from remote by default");
  await app.wait(80);
  await expect(app.texts()).toContain(`call server.updateSettings {"patch":{"projectSettingsOverrides":{"project:1":{"newWorktreesStartFromOrigin":false}}}}`);
});

test("a project without an override inherits, and an override can be reset to the inherited value", async () => {
  const app = await open("./ScopeFixture.tsx", { width: 1100, height: 1400 });
  await app.press("label:Project scope: All projects");
  await app.press("label:legion");
  await app.press("label:Reset Start from remote to default");
  await app.wait(80);
  await expect(app.texts()).toContain(`call server.updateSettings {"patch":{"projectSettingsOverrides":{"project:1":null}}}`);
  await expect(app.shows("id:Start new worktrees from remote by default (off)")).toBe(true);
});

test("a project's worktree cleanup is Inherit until Custom, which shows its rules and writes them as that project's", async () => {
  const app = await open("./ScopeFixture.tsx", { width: 1100, height: 2400 });
  await expect(app.shows("label:Automatic worktree cleanup = inherit")).toBe(false);
  await expect(app.shows("label:Worktree location")).toBe(true);
  await app.press("label:Project scope: All projects");
  await app.press("label:legion");
  await expect(app.shows("label:Automatic worktree cleanup = inherit")).toBe(true);
  await expect(app.texts()).toContain("Use each machine's worktree cleanup settings.");
  await expect(app.shows("label:Delete merged worktrees")).toBe(false);
  await expect(app.shows("label:Worktree location")).toBe(false);
  await app.press("label:Automatic worktree cleanup = inherit");
  await app.press("label:Custom");
  await app.wait(80);
  await expect(app.shows("label:Delete merged worktrees")).toBe(true);
  await app.press("label:Delete merged worktrees");
  await app.wait(80);
  await expect(app.texts()).toContain(`call server.updateSettings {"patch":{"projectSettingsOverrides":{"project:1":{"newWorktreesStartFromOrigin":true,"worktreeCleanup":{"mode":"custom","rules":{"worktreeKeepWhen":"uncommitted-changes","worktreeAfterDays":null,"worktreeSettledAfterDays":null,"worktreeOnMerge":true,"worktreeOnDelete":false,"worktreeUnchanged":false}}}}}}`);
});

test("the scope bar lists saved environments, and one that is not live asks to reconnect", async () => {
  const app = await open("./ScopeFixture.tsx", { width: 1100, height: 1400 });
  await app.press("label:Environment scope: All environments");
  await app.press("label:Build box");
  await expect(app.texts()).toContain("Reconnect Build box to change its settings.");
  await expect(app.shows("label:Environment scope: Build box")).toBe(true);
});

test("a single-environment page (Providers, Secrets) reads 'on <machine>' and offers no All environments choice", async () => {
  const app = await open("./ScopeSingleFixture.tsx", { width: 1100, height: 400 });
  await app.waitFor("label:Environment scope: legion");
  await expect(app.texts()).toContain("on");
  await expect(app.texts()).not.toContain("across");
  await app.press("label:Environment scope: legion");
  await expect(app.shows("label:All environments")).toBe(false);
});

test("the submodules row names its control, and describes the scope it edits", async () => {
  const app = await open("./ScopeFixture.tsx", { width: 1100, height: 2400 });
  await app.press("label:Advanced >> nth=0");
  await expect(app.texts()).toContain("How new worktrees populate git submodules. Projects and their t3.json can override it.");
  await expect(app.shows("label:Worktree submodules = recursive")).toBe(true);
  await app.press("label:Project scope: All projects");
  await app.press("label:legion");
  // The panel can remain mounted when only the selected scope changes, so
  // preserve an already-open Advanced section instead of closing it.
  if (!app.texts().includes("How new worktrees in this project populate git submodules.")) await app.press("label:Advanced >> nth=0");
  await expect(app.texts()).toContain("How new worktrees in this project populate git submodules.");
});

test("a session without settings:write keeps the value and says why the save failed", async () => {
  const app = await open("./ScopeFixture.tsx", { width: 1100, height: 1400 });
  await app.press("label:Deny writes");
  await app.press("label:Start new worktrees from remote by default");
  await expect(app.texts()).toContain("Setting not saved");
  await expect(app.texts()).toContain("Could not save on legion: This connection lacks permission to change these settings.");
  await expect(app.texts().some((text) => text.startsWith("call server.updateSettings"))).toBe(false);
});

test("the scope menus search their options and say when nothing matches", async () => {
  const app = await open("./ScopeFixture.tsx", { width: 1100, height: 1400 });
  await app.press("label:Project scope: All projects");
  await app.type("label:Search projects", "zzzz");
  await expect(app.texts()).toContain("No matches found.");
});
