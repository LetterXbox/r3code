import { expect, open, test } from "nsh/test";
import { BROWSER_IMPORT_FAILURE_COPY, cookieCountLabel, importableSources, importFailureReason, importPolicyRefusal } from "./browserImportWizardLogic";

test("the Configure step lists the browser's profiles and the target profiles, and imports", async () => {
  const app = await open("./BrowserImportWizardFixture.tsx", { width: 900, height: 900 });
  await app.press("label:open ok");
  for (const text of ["Import from Chrome", "Choose which cookies to import for Studio.", "FROM", "Person 1", "1,234 cookies", "Work", "1 cookie", "INTO", "New profile", "Created for these cookies", "Default", "Existing profile"]) await expect(app.texts()).toContain(text);
  await app.press("label:Import");
  await expect(app.texts()).toContain("Imported 1,234 cookies");
  for (const text of ["Added to Chrome for Studio. 3 cookies skipped.", "SKIPPED", "a.com, b.com, c.com and 1 more", "Done"]) await expect(app.texts()).toContain(text);
  await expect(app.texts().some((text) => text.includes("import Default -> new:profile-test"))).toBe(true);
  await app.press("label:Done");
  await expect(app.texts().some((text) => text.includes("close"))).toBe(true);
});

test("an open browser asks to be quit, then rechecks the source", async () => {
  const app = await open("./BrowserImportWizardFixture.tsx", { width: 900, height: 900 });
  await app.press("label:open running");
  for (const text of ["Quit Chrome to import", "Chrome is open, so its cookies can’t be read yet. Quit it, then continue."]) await expect(app.texts()).toContain(text);
  await app.press("label:I’ve quit it");
  await expect(app.texts()).toContain("Import from Chrome");
});

test("a platform the import cannot work on stops at Blocked with the reference's copy and no retry", async () => {
  const app = await open("./BrowserImportWizardFixture.tsx", { width: 900, height: 900 });
  await app.press("label:open unsupported");
  for (const text of ["Couldn’t import from Chrome", "Importing from this browser isn't possible on this platform.", "Close"]) await expect(app.texts()).toContain(text);
  await expect(app.texts()).not.toContain("Try again");
});

test("Full Disk Access asks for the permission and waits for it", async () => {
  const app = await open("./BrowserImportWizardFixture.tsx", { width: 900, height: 900 });
  await app.press("label:open fda");
  for (const text of ["Let R3 Code read Chrome’s cookies", "Full Disk Access", "Read Chrome's cookies for this import.", "Allow", "Continue"]) await expect(app.texts()).toContain(text);
  await app.press("label:Allow");
  await expect(app.texts()).toContain("Allowed");
  await app.press("label:Continue");
  await expect(app.texts()).toContain("Import from Chrome");
});

test("failure copy, importable sources and policy refusals follow the reference", () => {
  expect(BROWSER_IMPORT_FAILURE_COPY.keychainUnavailable).toBe("The system keyring could not be accessed. Make sure your desktop keyring is running and unlocked, then retry.");
  expect(BROWSER_IMPORT_FAILURE_COPY.readFailed).toBe("The browser's cookie database could not be read.");
  expect(importableSources([{ id: "a", name: "A", profiles: [] }, { id: "b", name: "B", unavailable: "notInstalled", profiles: [] }, { id: "c", name: "C", unavailable: "unsupportedPlatform", profiles: [] }, { id: "d", name: "D", unavailable: "browserRunning", profiles: [] }]).map((source) => source.id)).toEqual(["a", "d"]);
  expect(importFailureReason(new Error("Import failed: needsFullDiskAccess."))).toBe("needsFullDiskAccess");
  expect(importFailureReason(new Error("nope"))).toBe("readFailed");
  expect(importPolicyRefusal(new Error("Error invoking: Acme's policy does not allow importing browser cookies."))).toBe("Acme's policy does not allow importing browser cookies.");
  expect(importPolicyRefusal(new Error("fine"))).toBeUndefined();
  expect(cookieCountLabel(0)).toBe("no cookies");
  expect(cookieCountLabel(undefined)).toBeUndefined();
});
