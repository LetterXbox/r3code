import { expect, open, test } from "nsh/test";

test("new thread opens the project chooser when several projects are available", async () => {
  const app = await open("./NewThreadChooserFixture.tsx", { width: 1000, height: 700 });
  await app.press("label:New thread");
  await app.waitFor("text:Projects");
  expect(app.texts()).toContain("Alpha");
  expect(app.texts()).toContain("Beta");
  expect(app.texts()).toContain("No project");
  await app.press("text:Beta");
  await app.waitFor("text:Selected project: p1");
});

test("new thread opens the sole project directly", async () => {
  const app = await open("./NewThreadChooserFixture.tsx", { width: 1000, height: 700 });
  await app.press("label:Leave one project");
  await app.press("label:New thread");
  await app.waitFor("text:Selected project: p0");
  expect(app.texts()).not.toContain("No project");
});

test("shift-click creates a thread in the current project", async () => {
  const app = await open("./NewThreadChooserFixture.tsx", { width: 1000, height: 700 });
  await app.keyboard.down("shift");
  await app.press("label:New thread");
  await app.keyboard.up("shift");
  await app.waitFor("text:Selected project: p0");
  expect(app.texts()).not.toContain("No project");
});

test("with no projects the sidebar opens a projectless draft directly", async () => {
  const app = await open("./NewThreadChooserFixture.tsx", { width: 1000, height: 700 });
  await app.press("label:Remove all projects");
  await app.waitFor("text:No projects yet");
  await app.press("label:New thread");
  await app.waitUntil(() => app.texts().includes("Selected project: "));
  expect(app.texts()).not.toContain("Projects");
});

test("the new-thread command treats two checkouts of one repository as one project", async () => {
  const app = await open("./NewThreadChooserFixture.tsx", { width: 1000, height: 700 });
  await app.press("label:Group projects");
  await app.press("label:Run new thread command");
  await app.waitFor("text:Selected project: p0");
  expect(app.texts()).not.toContain("No project");
});

test("the chooser lists a repository once when it has multiple checkouts", async () => {
  const app = await open("./NewThreadChooserFixture.tsx", { width: 1000, height: 700 });
  await app.press("label:Add grouped and separate projects");
  await app.press("label:New thread");
  await app.waitFor("text:Projects");
  expect(app.texts()).toContain("repo");
  expect(app.texts()).toContain("Gamma");
  expect(app.texts()).not.toContain("Beta");
  await app.press("text:repo");
  await app.waitFor("text:Selected project: p0");
});
