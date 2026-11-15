import { expect, open, test } from "nsh/test";

test("a single command stays in its lane as its work group changes", async () => {
  const app = await open("./SingleCommandFixture.tsx", { width: 1100, height: 500, platform: "macos" });
  await app.waitFor("text:npm test");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("message-left:")) && app.texts().some((text) => text.startsWith("work-left:")));
  const position = (prefix: string) => Number(app.texts().find((text) => text.startsWith(prefix))?.slice(prefix.length));
  await expect(position("work-left:")).toBe(position("message-left:"));
  await expect(position("work-left:") > 0).toBe(true);
  await app.press("label:Add command");
  await app.waitFor("text:Ran 2 commands");
  await app.press("label:Remove command");
  await app.waitFor("text:npm test");
});

test("an active work group summarizes its command and retains the full command in details", async () => {
  const app = await open("./SingleCommandFixture.tsx", { width: 1100, height: 500, platform: "macos" });
  await app.press("label:Activate command");
  await app.waitFor("text:Running npm");
  await app.press("label:Expand Ran 1 command");
  await app.waitFor("text:npm test");
});

test("a work group folds its tool calls and opens each one", async () => {
  const app = await open("./TimelineRowsFixture.tsx", { width: 900, height: 900, clock: {} });
  await expect(app.texts()).toContain("Ran 1 command and changed 1 file");
  await expect(app.texts()).not.toContain("npm test");
  await app.press("label:Expand Ran 1 command and changed 1 file");
  await expect(app.texts()).toContain("npm test");
  await expect(app.texts()).toContain("Edited src/a.ts");
  await expect(app.texts()).toContain("+2");
  await app.press("label:Expand Command");
  await expect(app.texts()).toContain("$ npm test");
  await expect(app.texts()).toContain("All tests passed");
  await app.press("label:Collapse Command");
  await expect(app.texts()).not.toContain("$ npm test");
  await app.press("label:Collapse Ran 1 command and changed 1 file");
  await expect(app.texts()).not.toContain("Edited src/a.ts");
});

test("working indicator, divider, plan card and error banner render their copy", async () => {
  const app = await open("./TimelineRowsFixture.tsx", { width: 900, height: 900, clock: {} });
  await expect(app.texts()).toContain("Working for 1m 5s");
  await expect(app.shows("label:Working shimmer")).toBe(false);
  await expect(app.texts()).toContain("Context compacted");
  await expect(app.texts()).toContain("Ship it");
  await expect(app.texts()).toContain("Plan");
  await expect(app.texts()).toContain("Rate limited");
  await app.press("label:Dismiss error");
  await expect(app.texts()).toContain("Banner dismissed");
  await expect(app.texts()).not.toContain("Rate limited");
});

test("a long plan folds behind Expand plan, and the actions menu copies, downloads and saves it", async () => {
  const app = await open("./PlanCardFixture.tsx", { width: 900, height: 1000 });
  await expect(app.texts()).toContain("Big plan");
  await expect(app.shows("label:Expand plan")).toBe(true);
  await app.press("label:Expand plan");
  await expect(app.shows("label:Collapse plan")).toBe(true);
  await app.press("label:Collapse plan");
  await expect(app.shows("label:Expand plan")).toBe(true);
  await app.press("label:Plan actions");
  await app.press("label:Copy to clipboard");
  await expect(app.clipboard()).toContain("- step 30");
  await app.press("label:Plan actions");
  await app.press("label:Download as markdown");
  await app.waitFor("text:Downloaded big-plan.md");
});

test("Save to workspace asks for a path and writes through projects.writeFile", async () => {
  const app = await open("./PlanCardFixture.tsx", { width: 900, height: 1000 });
  await app.press("label:Plan actions");
  await app.press("label:Save to workspace");
  await expect(app.texts()).toContain("Save plan to workspace");
  await expect(app.value("label:Workspace path")).toBe("big-plan.md");
  await app.clear("label:Workspace path");
  await app.type("label:Workspace path", "../escape.md");
  await app.press("label:Save plan");
  await expect(app.texts()).toContain("Enter a path inside the workspace");
  await app.clear("label:Workspace path");
  await app.type("label:Workspace path", "docs/big-plan.md");
  await app.press("label:Save plan");
  // ProposedPlanCard reports the save as a success toast (title, then the relative path), not an inline line.
  await app.waitFor("text:Plan saved to workspace");
  await expect(app.texts()).toContain("big-plan.md");
  expect(app.texts().some((text) => text.includes('"cwd":"/work/space","relativePath":"docs/big-plan.md"'))).toBe(true);
});

test("the plan actions menu registers with the native-view occlusion registry while open", async () => {
  const app = await open("./PlanCardFixture.tsx", { width: 900, height: 1000 });
  await expect(app.texts()).toContain("overlays: 0");
  await app.press("label:Plan actions");
  await expect(app.texts()).toContain("overlays: 1");
  await app.press("label:Copy to clipboard");
  await expect(app.texts()).toContain("overlays: 0");
});

test("compacting and worktree setup replace the Working label", async () => {
  const app = await open("./WorkingModesFixture.tsx", { width: 900, height: 300, clock: {} });
  await expect(app.texts()).toContain("Compacting for 4s");
  await expect(app.texts()).toContain("Setting up worktree…");
  // TimelineWorkGroupRows: a working row with no start time yet reads "Working...", not a timer from 0s.
  await expect(app.texts()).toContain("Working...");
});

test("a work group carries a day-aware timestamp for its first call", async () => {
  const app = await open("./TimelineRowsFixture.tsx", { width: 900, height: 900, clock: {} });
  // The call is an hour old: today it shows the time, and within an hour after midnight it was yesterday ("yesterday at <time>"
  // in formatDayAwareTimestamp), so the stamp is the time of day with that optional prefix whatever the time the test runs.
  expect(app.texts().some((text) => /^(yesterday at )?\d{1,2}[:.]\d{2}/.test(text))).toBe(true);
});

test("a command whose output was withheld is fetched with getTurnItem when its row opens", async () => {
  const app = await open("./ItemDetailFixture.tsx", { width: 900, height: 600, clock: {} });
  await app.press("label:Expand Command");
  await app.waitFor("text:built 12 files");
  await expect(app.shows('label:orchestration.getTurnItem:{"threadId":"t1","itemId":"cmd-1","revision":"2026-01-01T00:00:00Z"}')).toBe(true);
});
