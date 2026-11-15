import { expect, open, test } from "nsh/test";

test("the project name is a picker that searches, switches project and offers Add project", async () => {
  const app = await open("./DraftHeroFixture.tsx", { width: 1100, height: 700 });
  await expect(app.texts()).toContain("Alpha");
  await app.press("label:Choose project");
  await expect(app.shows("label:Search projects")).toBe(true);
  await expect(app.shows("label:Add project")).toBe(true);
  await app.type("label:Search projects", "bet");
  await expect(app.shows("label:Project Alpha")).toBe(false);
  await expect(app.shows("label:Add project")).toBe(false);
  await app.press("label:Project Beta");
  await expect(app.texts()).toContain("Beta");
  await expect(app.shows("label:Search projects")).toBe(false);
});

test("a search with no match says so", async () => {
  const app = await open("./DraftHeroFixture.tsx", { width: 1100, height: 700 });
  await app.press("label:Choose project");
  await app.type("label:Search projects", "zzz");
  await expect(app.texts()).toContain("No matching projects.");
});

test("Add project opens the add project flow", async () => {
  const app = await open("./DraftHeroFixture.tsx", { width: 1100, height: 700 });
  await app.press("label:Choose project");
  await app.press("label:Add project");
  await expect(app.texts()).toContain("Add project opened");
});

test("the heading reads inline when wide and stacks when narrow", async () => {
  const wide = await open("./DraftHeroFixture.tsx", { width: 1100, height: 700 });
  await expect(wide.texts()).toContain("What should we build in");
  await wide.press("label:Narrow");
  await expect(wide.texts()).toContain("What should we build?");
  await expect(wide.texts()).toContain("Alpha");
});

test("with no project the heading asks to add one", async () => {
  const app = await open("./DraftHeroFixture.tsx", { width: 1100, height: 700 });
  await app.press("label:No projects");
  await expect(app.texts()).toContain("Add a project to start");
});

test("a scratch draft asks What should we work on? with the picker reading No project below (DraftHeroHeadline)", async () => {
  const app = await open("./DraftHeroFixture.tsx", { width: 1100, height: 500, platform: "macos" });
  await app.press("label:Use scratch");
  await app.waitFor("text:What should we work on?");
  await expect(app.texts()).toContain("No project");
  await expect(app.texts()).not.toContain("or start without a project");
});

test("the triage hero asks What went wrong? and copies the CLI command (TriageDraftHero)", async () => {
  const app = await open("./TriageHeroFixture.tsx", { width: 1000, height: 300, platform: "macos" });
  await expect(app.texts()).toContain("What went wrong?");
  await expect(app.texts()).toContain("This machine");
  await expect(app.texts()).toContain("npx t3 triage");
  await app.press("label:Copy command, for a terminal");
  await app.waitFor("text:Copied");
});
