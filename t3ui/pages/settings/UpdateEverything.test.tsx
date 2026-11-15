import { expect, open, test } from "nsh/test";
import { updateEverythingDescription, updateEverythingProgress, updateEverythingSummary, updateEverythingTitle } from "./providers/updateEverything";

const SIZE = { width: 1000, height: 800 };
const provider = (name: string, status: "waiting" | "updating" | "done" | "failed", failure: string | null = null) => ({ instanceId: name, driver: name, name, status, failure });

test("title, description, progress and result copy follow updateEverything.logic", () => {
  const machines = [{ key: "a", label: "Mac", skipped: null, providers: [provider("Codex", "done"), provider("Claude", "failed", "npm exited with 1")] }, { key: "b", label: "Box", skipped: "Offline", providers: [] }];
  expect(updateEverythingTitle(machines)).toBe("Update 1 machine?");
  expect(updateEverythingDescription(2, true)).toBe("2 provider updates · Checking for more…");
  expect(updateEverythingDescription(1, false)).toBe("1 provider update");
  expect(updateEverythingProgress(machines)).toBe("1 of 2 updated");
  expect(updateEverythingSummary(machines)).toEqual({ type: "error", title: "Updated 1 provider", description: "Mac · Claude: npm exited with 1" });
  expect(updateEverythingSummary([{ key: "a", label: "Mac", skipped: null, providers: [provider("Codex", "done"), provider("Claude", "done")] }])).toEqual({ type: "success", title: "Updated 2 providers" });
  expect(updateEverythingSummary([{ key: "a", label: "Mac", skipped: null, providers: [provider("Codex", "failed", "x")] }])?.title).toBe("Update failed");
  expect(updateEverythingSummary([{ key: "a", label: "Mac", skipped: null, providers: [provider("Codex", "waiting")] }])).toBeNull();
});

test("the modal lists the providers per machine, notes skipped machines, confirms and shows progress then the result", async () => {
  const app = await open("./UpdateEverythingFixture.tsx", SIZE);
  await expect(app.shows("id:Update everything dialog")).toBe(true);
  for (const value of ["Update 1 machine?", "2 provider updates", "Machine", "Providers", "Fixture host", "Codex", "Claude", "1 skipped", "Build box", "Not connected"]) await expect(app.texts()).toContain(value);
  await app.press("label:Update");
  await expect(app.texts()).toContain("confirmed");
  await expect(app.texts()).toContain("Updating providers");
  await expect(app.texts()).toContain("updating providers");
  await app.press("label:Finish with a failure");
  await expect(app.texts()).toContain("Updated 1 provider");
  await expect(app.texts()).toContain("Fixture host · Claude: npm exited with 1");
  await app.press("label:Close update dialog");
  await expect(app.texts()).toContain("open false");
});

test("Cancel closes the confirmation without running anything", async () => {
  const app = await open("./UpdateEverythingFixture.tsx", SIZE);
  await app.press("label:Cancel update");
  await expect(app.texts()).toContain("closed");
  await expect(app.texts()).not.toContain("confirmed");
});
