import { expect, open, test } from "nsh/test";

test("appearance selection is saved and updates the choice", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.press("text:Appearance");
  await expect(app.shows("id:Appearance mode system (on)")).toBe(true);
  await app.press("label:Use dark mode");
  await app.waitUntil(() => app.storage().settings?.includes('"colorScheme":"dark"') === true);
  await expect(app.shows("id:Appearance mode dark (on)")).toBe(true);
  await expect(app.shows("id:Appearance mode system (off)")).toBe(true);
});

test("theme cards list the built-in themes and record the light and dark halves", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 1000 });
  await app.keyboard.press("mod+,");
  await app.press("text:Appearance");
  for (const label of ["Color scheme", "Themes", "R3 Code", "T3 Chat", "Grove", "Ocean", "Ember", "Iris"]) await expect(app.texts()).toContain(label);
  await expect(app.shows("id:Theme card ocean (active)")).toBe(true);
  await app.press("label:Use Ocean theme");
  await app.waitUntil(() => app.storage().settings?.includes('"themeLight":"ocean"') === true);
  await expect(app.storage().settings?.includes('"themeDark":"ocean"')).toBe(true);
  await expect(app.shows("id:Theme card ocean (active)")).toBe(true);
  await app.press("label:Use Grove dark mode");
  // The app is built in Ocean and cannot recolour: another theme is saved, never shown as active.
  await expect(app.shows("id:Grove dark (unpicked)")).toBe(true);
  await expect(app.shows("id:Ocean dark (picked)")).toBe(true);
  await expect(app.shows("id:Ocean light (picked)")).toBe(true);
});

test("the Add Environment dialog rejects invalid and credential-bearing hosts", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.press("text:Environments");
  await app.press("label:Add environment");
  await app.type("label:Pairing code", "CODE");
  for (const host of ["ht!tp://", "wss://user:secret@example.test/ws", "wss://example.test/ws?wsTicket=secret"]) {
    await app.clear("label:Host");
    await app.type("label:Host", host);
    await app.press("label:Confirm add environment");
    await expect(app.texts()).toContain("Enter the backend host, such as backend.example.com.");
  }
  await expect(app.storage().environmentUrl).toBe(undefined);
});

test("supported sidebar preferences save real option values", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.press("id:Project order = updated_at");
  await app.press("label:Created at");
  await expect(app.shows("id:Project order = created_at")).toBe(true);
  await app.press("id:Time format = locale");
  await app.press("label:12-hour");
  await app.waitUntil(() => app.storage().settings?.includes('"timestampFormat":"12-hour"') === true);
  await expect(app.shows("id:Time format = 12-hour")).toBe(true);
});

test("pairing tokens are sent separately and never stored", async () => {
  const app = await open("./App.tsx", {
    width: 1280, height: 800,
    network: { "POST http://example.test/oauth/token": { status: 401 } },
  });
  await app.keyboard.press("mod+,");
  await app.press("text:Environments");
  await app.press("label:Add environment");
  await app.type("label:Host", "ws://example.test/ws");
  await app.type("label:Pairing code", "private-pairing-value");
  await app.press("label:Confirm add environment");
  await app.waitUntil(() => app.storage().environmentUrl === "ws://example.test/ws");
  await expect(JSON.stringify(app.storage()).includes("private-pairing-value")).toBe(false);
  await app.waitFor("text:Pairing failed (HTTP 401)");
});

test("archived threads do not claim to be empty while disconnected", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.press("text:Archive");
  await expect(app.texts()).toContain("Connect an environment to see archived threads.");
  await expect(app.texts()).not.toContain("No archived threads.");
});

test("saved appearance overrides the system setting at startup", async () => {
  const systemDark = await open("./App.tsx", { width: 1280, height: 800, colorScheme: "dark" });
  const savedDark = await open("./App.tsx", { width: 1280, height: 800, colorScheme: "light", storage: { settings: '{"colorScheme":"dark"}' } });
  await savedDark.waitUntil(() => savedDark.spanStyle("text:No active thread").color === systemDark.spanStyle("text:No active thread").color);
  await expect(savedDark.spanStyle("text:No active thread").color).toBe(systemDark.spanStyle("text:No active thread").color);
});

test("settings avoid inventing project and scheduled task data", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.press("text:Projects");
  await expect(app.texts()).toContain("Choose a project to manage its name, icon, checkouts and actions.");
  await app.press("text:Scheduled tasks");
  await expect(app.texts()).toContain("Connect an environment to manage scheduled tasks.");
  await expect(app.texts()).not.toContain("No scheduled tasks");
});

test("send shortcut preference can be changed", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.press("text:Chat");
  await app.press("id:Send shortcut = enter");
  await app.press("label:⌘ + Enter always");
  await app.waitUntil(() => app.storage().settings?.includes('"sendShortcut":"mod-enter"') === true);
  await expect(app.shows("id:Send shortcut = mod-enter")).toBe(true);
});

test("diff layout preference can be changed", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.press("text:Diffs & pull requests");
  await app.press("id:Diff layout = stacked");
  await app.press("label:Split");
  await app.waitUntil(() => app.storage().settings?.includes('"diffLayout":"split"') === true);
  await expect(app.shows("id:Diff layout = split")).toBe(true);
});

test("hide-whitespace preference can be changed", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.press("text:Diffs & pull requests");
  await app.press("label:Hide whitespace changes");
  await app.waitUntil(() => app.storage().settings?.includes('"diffIgnoreWhitespace":false') === true);
  await expect(app.shows("id:Hide whitespace changes (off)")).toBe(true);
});

test("settings header shows the breadcrumb and restores device defaults", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await expect(app.texts()).toContain("Settings");
  await expect(app.texts()).toContain("General");
  await expect(app.shows("label:Close settings")).toBe(true);
  await app.press("id:Time format = locale");
  await app.press("label:12-hour");
  await expect(app.shows("id:Time format = 12-hour")).toBe(true);
  await expect(app.shows("label:Reset Time format to default")).toBe(true);
  await app.press("label:Restore device defaults");
  await expect(app.texts()).toContain("This will reset: Time format.");
  await app.press("label:Confirm");
  await expect(app.shows("id:Time format = locale")).toBe(true);
});

test("a changed setting can be reset from its row", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.press("id:Project order = updated_at");
  await app.press("label:Created at");
  await app.press("label:Reset Project order to default");
  await expect(app.shows("id:Project order = updated_at")).toBe(true);
});

test("about shows the copyable version, the mobile app stores, and the licenses subpage", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 1000 });
  await app.keyboard.press("mod+,");
  await app.press("text:About");
  await expect(app.texts()).toContain("Version");
  // VersionTitle now shows buildVersionLabel()'s R3/T3 pair (AboutPanel.tsx), not the bare
  // server-version fallback this used to assert; the placeholder build carries "unknown".
  await expect(app.texts()).toContain("R3 unknown (unknown) - T3 unknown (unknown)");
  await expect(app.texts()).toContain("Mobile app");
  await expect(app.texts()).toContain("iPhone and iPad");
  await expect(app.texts()).toContain("Android");
  await expect(app.texts()).toContain("Update track");
  await expect(app.texts()).toContain("Stable");
  await app.press("label:iPhone and iPad");
  await expect(app.texts()).toContain("Scan with your phone camera.");
  await expect(app.texts()).toContain("Open App Store");
  await app.keyboard.press("escape");
  await app.press("label:View licenses");
  await expect(app.texts()).toContain("Open source licenses");
});
