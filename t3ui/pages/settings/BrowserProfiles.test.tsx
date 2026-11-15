import { expect, open, test } from "nsh/test";
import { clearData } from "./BrowserProfiles";
import { clearToasts, visibleToasts } from "../../components/toast/toastState";
import { createProfile, listedProfiles, parseUserProfiles, removeProfile, renameProfile, resolveProfiles, resolvedDefaultId } from "./browserProfilesLogic";
import { canCloseWizard, formatSkippedDomains, fullDiskAccessRecheckStep, initialWizardStep, isRetryableReason, outcomeToStep, refreshedSourceProfileDirectory } from "./browserImportWizardLogic";

const work = { id: "profile-1", name: "Work", kind: "persistent" as const };

test("profiles resolve with the built-ins first, never list Incognito and fall back to Default", () => {
  expect(resolveProfiles([work, { id: "default", name: "Dup", kind: "persistent" }]).map((profile) => profile.id)).toEqual(["default", "incognito", "profile-1"]);
  expect(listedProfiles([work]).map((profile) => profile.name)).toEqual(["Default", "Work"]);
  expect(resolvedDefaultId([work], "profile-1")).toBe("profile-1");
  expect(resolvedDefaultId([work], "gone")).toBe("default");
  expect(parseUserProfiles(JSON.stringify([work, { id: "", name: "x" }, "junk"]))).toEqual([work]);
  expect(parseUserProfiles("not json")).toEqual([]);
});

test("a new profile gets a free name, rename trims and caps, and removing the default falls back", () => {
  const first = createProfile([], "New profile", "a")!;
  expect(first.created.name).toBe("New profile");
  expect(createProfile(first.profiles, "New profile", "b")!.created.name).toBe("New profile 2");
  expect(createProfile(Array.from({ length: 24 }, (_, index) => ({ id: `p${index}`, name: `P${index}`, kind: "persistent" as const })), "New profile", "z")).toBe(null);
  expect(renameProfile([work], "profile-1", "  Personal  ")[0]?.name).toBe("Personal");
  expect(renameProfile([work], "profile-1", "   ")[0]?.name).toBe("Work");
  expect(removeProfile([work], "profile-1", "profile-1")).toEqual({ profiles: [], defaultId: "default" });
  expect(removeProfile([work], "default", "profile-1").defaultId).toBe("default");
});

test("the import wizard starts where the browser's state says and ends on what the import returned", () => {
  const source = { id: "chrome", name: "Chrome", profiles: [{ directory: "Default" }] };
  expect(initialWizardStep(source)).toEqual({ step: "configure" });
  expect(initialWizardStep({ ...source, unavailable: "browserRunning" })).toEqual({ step: "quit" });
  expect(initialWizardStep({ ...source, unavailable: "needsFullDiskAccess" })).toEqual({ step: "fullDiskAccess", resume: "configure" });
  expect(initialWizardStep({ ...source, profiles: [] })).toEqual({ step: "blocked", reason: "unknownSourceProfile" });
  expect(outcomeToStep({ kind: "imported", imported: 3, skipped: 1, skippedDomains: ["a.com"], targetName: "Work" })).toEqual({ step: "done", imported: 3, skipped: 1, skippedDomains: ["a.com"], targetName: "Work" });
  expect(outcomeToStep({ kind: "blocked", reason: "needsFullDiskAccess" })).toEqual({ step: "fullDiskAccess", resume: "import", checked: true });
  expect(fullDiskAccessRecheckStep({ ...source, unavailable: "needsFullDiskAccess" })).toEqual({ step: "fullDiskAccess", resume: "configure", checked: true });
  expect(refreshedSourceProfileDirectory("Profile 2", source)).toBe("Default");
  expect(canCloseWizard({ step: "importing" })).toBe(false);
  expect(isRetryableReason("readFailed")).toBe(true);
  expect(isRetryableReason("browserRunning")).toBe(false);
  expect(formatSkippedDomains(["a.com", "b.com", "c.com", "d.com", "e.com"])).toBe("a.com, b.com, c.com and 2 more");
});

test("a failed clear toasts the profile's name without the server's error", async () => {
  clearToasts();
  expect(await clearData(work, async () => { throw new Error("boom"); })).toBe(false);
  expect(visibleToasts().map((toast) => [toast.title, toast.description])).toEqual([["Could not clear Work's data", undefined]]);
  clearToasts();
  expect(await clearData(work, async () => ({}))).toBe(true);
  expect(visibleToasts()).toHaveLength(0);
});
