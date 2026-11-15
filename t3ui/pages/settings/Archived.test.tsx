import { expect, open, test } from "nsh/test";

test("archived threads group by project, newest first, with archive and creation ages", async () => {
  const app = await open("./ArchivedFixture.tsx", { width: 1100, height: 1000 });
  for (const text of ["Alpha", "Beta", "Fix flaky build", "Newer archive", "Archived 1h ago · Created 3d ago", "Archived 2d ago · Created 5d ago", "Archived 10m ago · Created 1d ago"]) await expect(app.texts()).toContain(text);
  const texts = app.texts();
  await expect(texts.indexOf("Newer archive") < texts.indexOf("Fix flaky build")).toBe(true);
});

test("unarchive restores a thread and refreshes the list", async () => {
  const app = await open("./ArchivedFixture.tsx", { width: 1100, height: 1000 });
  await app.press("label:Unarchive Fix flaky build");
  await app.waitFor("text:restored t1");
  await expect(app.texts()).toContain("refreshed");
  await expect(app.texts()).not.toContain("Fix flaky build");
});

test("a failed unarchive shows the error and keeps the row", async () => {
  const app = await open("./ArchivedFixture.tsx", { width: 1100, height: 1000 });
  await app.press("label:Fail actions");
  await app.press("label:Unarchive Newer archive");
  await app.waitFor("text:Failed to unarchive thread");
  await expect(app.texts()).toContain("server said no");
  await expect(app.texts()).toContain("Newer archive");
});

test("delete asks first when thread delete confirmation is on, and can be cancelled", async () => {
  const app = await open("./ArchivedFixture.tsx", { width: 1100, height: 1000 });
  await app.press("label:Delete Other project work");
  await expect(app.texts()).toContain('Delete thread "Other project work"?');
  await expect(app.texts()).toContain("This permanently clears conversation history for this thread.\nThis action cannot be undone.");
  await app.press("label:Cancel");
  await expect(app.texts()).toContain("Other project work");
  await app.press("label:Delete Other project work");
  await app.press("label:Confirm");
  await app.waitFor("text:deleted t3");
  await expect(app.texts()).not.toContain("Other project work");
});

test("delete is immediate when confirmation is off; empty and disconnected states read as the web does", async () => {
  const app = await open("./ArchivedFixture.tsx", { width: 1100, height: 1000 });
  await app.press("label:No confirm");
  await app.press("label:Delete Fix flaky build");
  await app.waitFor("text:deleted t1");
  await app.press("label:Empty fixture");
  await expect(app.texts()).toContain("No archived threads");
  await expect(app.texts()).toContain("Archived threads will appear here.");
  await app.press("label:Disconnect fixture");
  await expect(app.texts()).toContain("Connect an environment to see archived threads.");
  await expect(app.texts()).not.toContain("No archived threads");
});
