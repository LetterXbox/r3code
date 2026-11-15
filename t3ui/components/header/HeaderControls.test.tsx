import { expect, open, test } from "nsh/test";

const size = { width: 1280, height: 800, platform: "macos" } as const;

test("the subagent breadcrumb displays the readable agent name", async () => {
  const app = await open("./SubagentBreadcrumbFixture.tsx", size);
  await expect(app.shows("label:Smoke Origin")).toBe(true);
  await expect(app.texts()).not.toContain("/root/smoke_origin");
});

// The header is a window drag region; its controls, title and breadcrumb must still take presses.
test("pressing each header control toggles it", async () => {
  const app = await open("../rightPanel/WorkspaceFixture.tsx", size);
  await app.waitFor("label:Toggle thread details panel");
  await app.press("label:Toggle thread details panel");
  await app.waitFor("label:Thread details");
  await app.press("label:Toggle thread details panel");
  await expect(app.shows("label:Thread details")).toBe(false);
  await app.press("label:Toggle terminal drawer");
  await app.waitFor("text:drawer-height:280");
});

test("pressing the title opens its menu and the project name starts a thread, inside the drag region", async () => {
  const app = await open("../rightPanel/WorkspaceFixture.tsx", size);
  await app.press("label:Thread actions for Fix the build");
  await app.waitFor("label:Archive thread");
  await app.keyboard.press("escape");
  await app.press("label:Open parent thread: Plan the work");
  await expect(app.texts().join("|")).toContain("open-thread:parent-1");
});

test("with the right panel open the header keeps the details toggle and the panel's bar takes the rest", async () => {
  const app = await open("../rightPanel/WorkspaceFixture.tsx", size);
  await app.press("label:Toggle right panel");
  await app.waitFor("label:Open a surface");
  // One details toggle (the header's), one terminal and one panel toggle (the panel's bar).
  await expect(app.shows("label:Toggle thread details panel")).toBe(true);
  await expect(app.shows("label:Toggle terminal drawer")).toBe(true);
  await expect(app.shows("label:Toggle right panel")).toBe(true);
  await app.press("label:Toggle thread details panel");
  await app.waitFor("label:Thread details");
});
