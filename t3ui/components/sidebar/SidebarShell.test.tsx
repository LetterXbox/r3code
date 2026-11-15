import { expect, open, test } from "nsh/test";

const options = { width: 1280, height: 800, platform: "macos" as const };

test("the header has the thread search and New thread; Add project appears only with projects", async () => {
  const app = await open("../../App.tsx", options);
  await expect(app.shows("label:Search threads")).toBe(true);
  await expect(app.shows("label:New thread")).toBe(true);
  await expect(app.texts()).toContain("Code");
  // The only Add project control is the empty state's own.
  await expect(app.count("label:Add project")).toBe(1);
});

test("with no projects the list shows the web's empty state", async () => {
  const app = await open("../../App.tsx", options);
  await expect(app.texts()).toContain("No projects yet");
  await expect(app.shows("label:Add project")).toBe(true);
  await expect(app.texts()).not.toContain("Settled");
});

test("the footer offers Settings and Usage, and Pull requests only once an environment delivered its config", async () => {
  // usePullRequestsSupported: a fresh, disconnected app has no environment, so no Pull requests entry.
  const app = await open("../../App.tsx", options);
  await expect(app.shows("label:Settings")).toBe(true);
  await expect(app.shows("label:Pull requests")).toBe(false);
  await expect(app.shows("label:Usage")).toBe(true);
  await app.press("label:Usage");
  await app.waitFor("text:Connect an environment to see limits.");
});

test("thread navigation shortcuts are inert with no threads", async () => {
  const app = await open("../../App.tsx", options);
  await app.keyboard.press("mod+shift+]");
  await app.keyboard.press("mod+shift+[");
  await app.keyboard.press("mod+1");
  await expect(app.shows("label:Search threads")).toBe(true);
});

test("saved sidebar state loads without being overwritten", async () => {
  const saved = JSON.stringify({ settledExpanded: true, snoozedExpanded: false, collapsedProjects: ["project:gone"] });
  const app = await open("../../App.tsx", { ...options, storage: { "sidebar.prefs": saved } });
  await app.wait(100);
  const stored = JSON.parse(app.storage()["sidebar.prefs"] ?? "{}");
  await expect(stored.settledExpanded).toBe(true);
  await expect(stored.collapsedProjects).toEqual(["project:gone"]);
});

test("the blueprint backdrop sits behind a header of toggle, wordmark, back and forward", async () => {
  const app = await open("../../App.tsx", options);
  await expect(app.shows("label:Sidebar backdrop")).toBe(true);
  await expect(app.shows("label:Toggle main sidebar")).toBe(true);
  await expect(app.shows("label:Go back")).toBe(true);
  await expect(app.shows("label:Go forward")).toBe(true);
  await expect(app.texts()).toContain("Code");
});

test("the toggle hides the sidebar, backdrop included", async () => {
  const app = await open("../../App.tsx", options);
  await app.press("label:Toggle main sidebar");
  await expect(app.shows("label:Sidebar backdrop")).toBe(false);
});

test("the footer ends with the round Check for updates button, on utility pages too", async () => {
  const app = await open("../../App.tsx", options);
  await expect(app.shows("label:Check for updates")).toBe(true);
  await app.press("label:Usage");
  await expect(app.shows("label:Check for updates")).toBe(true);
});
