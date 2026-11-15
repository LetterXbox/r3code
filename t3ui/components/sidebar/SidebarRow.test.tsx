import { expect, open, test } from "nsh/test";

const options = { width: 300, height: 700, platform: "macos" as const };

test("an unopened thread with an unsent draft shows the draft marker", async () => {
  const app = await open("./RowFixture.tsx", options);
  await expect(app.shows("label:Unsent draft")).toBe(true);
});

test("rows carry the status labels from ThreadStatusIndicators", async () => {
  const app = await open("./RowFixture.tsx", options);
  await expect(app.shows("label:Build the thing, Working, Demo")).toBe(true);
  await expect(app.shows("label:Needs a yes, Approval, Demo")).toBe(true);
  await expect(app.shows("label:Needs an answer, Input, Demo")).toBe(true);
  await expect(app.shows("label:Finished work, Done, Demo")).toBe(true);
  await expect(app.shows("label:Broken run, Failed, Demo")).toBe(true);
  await expect(app.shows("label:Quiet thread, Demo")).toBe(true);
  await expect(app.texts()).toContain("Working");
  await expect(app.texts()).toContain("Approval");
  await expect(app.texts()).toContain("Input");
  await expect(app.texts()).toContain("Done");
  await expect(app.texts()).toContain("Failed");
  await expect(app.texts()).toContain("5m");
});

test("a snoozed row shows its wake time instead of the age", async () => {
  const app = await open("./RowFixture.tsx", options);
  await expect(app.texts()).toContain("3h");
});

test("a card row shows the project line and the branch", async () => {
  const app = await open("./RowFixture.tsx", options);
  await expect(app.texts()).toContain("Pinned one");
});

test("right-click offers the thread menu above the list", async () => {
  const app = await open("./RowFixture.tsx", options);
  await app.rightClick("label:Quiet thread, Demo");
  await expect(app.shows("label:Rename thread")).toBe(true);
  await expect(app.shows("label:Mark unread")).toBe(true);
  await expect(app.shows("label:Copy")).toBe(true);
  await expect(app.shows("label:Project settings")).toBe(true);
  await expect(app.shows("label:Archive thread")).toBe(true);
  await expect(app.shows("label:Delete")).toBe(true);
});

test("a thread with a branch offers a new thread on it", async () => {
  const app = await open("./RowFixture.tsx", options);
  await app.rightClick("label:On a branch, Demo");
  await expect(app.shows("label:New thread on feat/side")).toBe(true);
});

test("rename edits the title in place", async () => {
  const app = await open("./RowFixture.tsx", options);
  await app.rightClick("label:Quiet thread, Demo");
  await app.press("label:Rename thread");
  await expect(app.value("label:Thread name")).toBe("Quiet thread");
  await app.type("label:Thread name", "Renamed");
  await app.submit("label:Thread name");
  await expect(app.shows("label:Thread name")).toBe(false);
});

test("a row has no ellipsis button: the thread menu is the right-click menu", async () => {
  const app = await open("./RowFixture.tsx", options);
  await app.hover("label:Quiet thread, Demo");
  await expect(app.shows("label:Actions for Quiet thread")).toBe(false);
});

test("a row with a worktree shows the worktree mark and Woke shows for a snooze that ran out", async () => {
  const app = await open("./RowFixture.tsx", options);
  await expect(app.shows("label:Worktree: wt-one (feat/wt)")).toBe(true);
  await expect(app.texts()).toContain("Woke");
  await expect(app.shows("label:Dismiss Woke notification")).toBe(true);
});

test("delete asks through the shared confirmation and names the thread", async () => {
  const app = await open("./RowFixture.tsx", options);
  await app.rightClick("label:Quiet thread, Demo");
  await app.press("label:Delete");
  await expect(app.shows("label:Delete thread \"Quiet thread\"?")).toBe(true);
  await expect(app.texts()).toContain("This permanently clears conversation history for this thread.");
  await expect(app.shows("label:Cancel")).toBe(true);
  await expect(app.shows("label:Confirm")).toBe(true);
  await app.press("label:Cancel");
  await expect(app.shows("label:Confirm")).toBe(false);
});

test("a disconnected environment hides the server-only items", async () => {
  const app = await open("./RowFixture.tsx", options);
  await app.rightClick("label:Quiet thread, Demo");
  await expect(app.shows("label:Pin thread")).toBe(false);
  await expect(app.shows("label:Settle thread")).toBe(false);
  await expect(app.shows("label:Snooze")).toBe(false);
});

test("Copy opens a submenu and Thread ID reaches the clipboard", async () => {
  const app = await open("./RowFixture.tsx", options);
  await app.rightClick("label:Quiet thread, Demo");
  await app.press("label:Copy");
  await expect(app.shows("label:Path")).toBe(true);
  await expect(app.shows("label:Thread ID")).toBe(true);
  await app.press("label:Thread ID");
  await expect(app.clipboard()).toBe("idle");
  // The copy is told through the shared toast host, as the web's toastManager does.
  await expect(app.texts()).toContain("Thread ID copied");
});

test("Copy > Path copies the thread's project path", async () => {
  const app = await open("./RowFixture.tsx", options);
  await app.rightClick("label:Quiet thread, Demo");
  await app.press("label:Copy");
  await app.press("label:Path");
  await expect(app.clipboard()).toBe("/tmp/demo");
  await expect(app.texts()).toContain("Path copied");
});

test("a card row with a pull request shows its number and state", async () => {
  const app = await open("./RowFixture.tsx", options);
  await expect(app.shows("label:Pull request #42, merged")).toBe(true);
  await expect(app.texts()).toContain("42");
  await expect(app.texts()).toContain("feat/pr");
});

test("mod-click selects rows and right-click offers the bulk menu with counts", async () => {
  const app = await open("./RowFixture.tsx", options);
  await app.keyboard.down("mod");
  await app.press("label:Quiet thread, Demo");
  await app.press("label:Broken run, Failed, Demo");
  await app.keyboard.up("mod");
  await app.rightClick("label:Quiet thread, Demo");
  await expect(app.shows("label:Mark unread (2)")).toBe(true);
  await expect(app.shows("label:Delete (2)")).toBe(true);
  await expect(app.shows("label:Rename thread")).toBe(false);
});

test("right-click on a card row (the live list's variant) opens the thread menu (pin, settle and snooze need a connected environment)", async () => {
  const app = await open("./RowFixture.tsx", options);
  await app.rightClick("label:Pinned one, Demo");
  for (const label of ["Rename thread", "Mark unread", "Copy", "Project settings", "Archive thread", "Delete"]) {
    await expect(app.shows(`label:${label}`)).toBe(true);
  }
});
