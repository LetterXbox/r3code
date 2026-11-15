import { expect, open, test } from "nsh/test";

test("the no-projects hero offers Add project; Start without a project needs a scratch root", async () => {
  const app = await open("./EmptyStatesFixture.tsx", { width: 800, height: 600 });
  await expect(app.texts()).toContain("What should we work on?");
  await expect(app.texts()).toContain("Add a project to start your first thread.");
  await expect(app.shows("label:Add project")).toBe(true);
  await expect(app.shows("label:Start without a project")).toBe(false);
  await expect(app.texts()).not.toContain("+ Add project");
});

test("the no-thread state has a title and description and no New thread button", async () => {
  const app = await open("./EmptyStatesFixture.tsx", { width: 800, height: 600 });
  await app.press("label:Toggle state");
  await expect(app.texts()).toContain("Pick a thread to continue");
  await expect(app.texts()).toContain("Select an existing thread or create a new one to get started.");
  await expect(app.shows("label:Start new thread")).toBe(false);
  await expect(app.texts()).not.toContain("New thread");
});
