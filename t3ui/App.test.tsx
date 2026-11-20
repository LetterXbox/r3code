// The shell's behaviour, headless: sidebar, threads, composer, palette, settings.
import { expect, open, test } from "nsh/test";

test("a fresh app shows a connection action instead of demo projects", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await expect(app.texts()).toContain("Connect an environment");
  await expect(app.texts()).not.toContain("Port the sidebar chrome");
  await expect(app.shows("label:New thread")).toBe(true);
});

test("the connection action opens environment settings", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.press("label:Connect environment");
  await expect(app.shows("label:Add environment")).toBe(true);
});

test("dropping a folder in the sidebar requires a connected local environment", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.dropFiles("label:New thread", ["file:///"]);
  await app.waitFor("text:Connect to this computer’s server to add dropped folders");
});

test("the new thread shortcut opens a draft", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+shift+n");
  await app.waitFor("id:composer-prompt");
  await expect(app.texts()).toContain("New thread");
});

test("a disconnected composer keeps a draft when submitted", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.press("label:New thread");
  await app.waitFor("id:composer-prompt");
  await app.type("id:composer-prompt", "Keep this draft");
  await app.waitFor("id:composer-prompt >> text:Keep this draft");
  await app.submit("id:composer-prompt");
  await app.waitFor("id:composer-prompt >> text:Keep this draft");
  await expect(app.enabled("label:Submit message")).toBe(false);
});

test("an empty draft cannot be sent", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.press("label:New thread");
  await app.waitFor("label:Submit message");
  await expect(app.enabled("label:Submit message")).toBe(false);
  await app.submit("id:composer-prompt");
  await expect(app.value("id:composer-prompt")).toBe("");
});

test("the palette lists actions without inventing recent threads", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+k");
  await app.waitFor("text:Actions");
  await expect(app.texts()).toContain("Actions");
  await expect(app.texts()).toContain("Open settings");
  // CommandPalette.tsx offers "New thread in..." only once a project exists.
  await expect(app.texts()).toContain("New thread without a project");
  await expect(app.texts()).not.toContain("Recent Threads");
});

test("typing in the palette narrows commands to matches", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+k");
  await app.waitFor("label:Search commands, projects, and threads");
  await app.waitFor("text:Open settings");
  await app.type("label:Search commands, projects, and threads", "usage");
  await app.waitUntil(() => {
    const texts = app.texts();
    return texts.includes("Open usage") && !texts.includes("Open settings");
  });
});

test("⌘, opens settings on General", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.wait(60);
  const texts = app.texts();
  await expect(texts).toContain("General");
  await expect(texts).toContain("Appearance");
  await expect(texts).toContain("Keybindings");
});

test("the settings nav lists every group from the web app", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.wait(60);
  const texts = app.texts();
  for (const group of ["Agents", "Code", "Connections"]) {
    await expect(texts).toContain(group);
  }
});

test("choosing a settings section switches the pane", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.wait(60);
  await app.press("text:Keybindings");
  await app.wait(60);
  // Keybindings is still a stub; General is a real panel. Both prove the
  // pane swapped, so assert on the heading rather than one panel's copy.
  await expect(app.texts()).toContain("Keybindings");
});

test("⌘, again closes settings and returns to the thread", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.wait(60);
  await app.keyboard.press("mod+,");
  await app.wait(60);
  await expect(app.texts()).not.toContain("Keybindings");
});

test("General shows the web app's sections and rows", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.wait(60);
  const texts = app.texts();
  for (const section of ["Notifications", "Sidebar", "Confirmations", "Display"]) {
    await expect(texts).toContain(section);
  }
  await expect(texts).toContain("In-app notifications");
  await expect(texts).toContain("Delete confirmation");
  await expect(texts).toContain(
    "Show a toast when another thread finishes, fails, or needs input or approval while this app has focus.",
  );
});

test("general switches are real controls bound to their settings", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await expect(app.texts()).toContain("In-app notifications");
  await expect(app.shows("id:In-app notifications (off)")).toBe(true);
  await app.press("label:In-app notifications");
  await app.waitFor("id:In-app notifications (on)");
});

test("the two linked subpages are reached by their link rows", async () => {
  // Diagnostics and Open source licenses are not in the nav -- the web reaches
  // them through a row on Maintenance and About. The row carries `target`, and
  // the panel renderer turns it into a press that opens that path.
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  const hops: [string, string, string][] = [
    ["Maintenance", "Diagnostics", "Connect an environment to see diagnostics."],
    ["About", "Open source licenses", "Third-party notices"],
  ];
  for (const [from, row, landed] of hops) {
    await app.keyboard.press("mod+,");
    await app.wait(60);
    await app.press(`text:${from}`);
    await app.wait(80);
    await expect(app.texts()).toContain(row);
    // The row's title is a label; the door itself is its "View" control,
    // which is the only pressable in the row.
    await app.press(from === "About" ? "text:View licenses" : "text:View");
    await app.wait(120);
    await expect(app.texts()).toContain(landed);
    // Close with the same shortcut that opened it: one press toggles, and it
    // does not depend on the close control being laid out mid-transition.
    await app.keyboard.press("mod+,");
    await app.wait(80);
  }
});

test("usage is its own page on mod+u, not a settings section", async () => {
  // The web's /usage is an app modal page (`isAppModalPage`) reached by
  // `usage.open` = mod+u, so it sits beside Settings rather than in its nav.
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+u");
  await app.wait(150);
  const shown = app.texts();
  // Header chrome from UsagePage, and the disconnected body. Totals and
  // Breakdown are the overview, which renders only once an environment reports.
  await expect(shown).toContain("Usage");
  await expect(shown).toContain("All environments");
  await expect(shown).toContain("Cost");
  await expect(shown).toContain("Tokens");
  await expect(shown).toContain("Limits");
  // Default metric is Limits, so the period group is hidden and the body is the limits sentence.
  await expect(shown).toContain("Connect an environment to see limits.");
  await expect(shown).not.toContain("Past 24h");
  await expect(shown).not.toContain("7 days");
  await expect(shown).not.toContain("Processed tokens");
  await app.press("label:Close");
  await app.wait(120);
  await expect(app.texts()).not.toContain("Connect an environment to see limits.");
}, 90_000);

test("usage's metric toggle swaps its body, and Limits drops the period", async () => {
  // UsagePage.tsx renders one body at a time: the overview, or the pooled
  // limits. Limits are always current, so picking it removes the period group
  // rather than disabling it.
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+u");
  await app.wait(150);
  await expect(app.texts()).not.toContain("Past 24h");
  await expect(app.texts()).toContain("Connect an environment to see limits.");

  await app.press("label:Cost");
  await app.wait(120);
  await expect(app.texts()).toContain("Past 24h");
  await expect(app.texts()).toContain("30 days");
  await expect(app.texts()).toContain("Connect an environment to see usage.");
  await expect(app.texts()).not.toContain("Connect an environment to see limits.");

  await app.press("label:Limits");
  await app.waitUntil(() => app.texts().includes("Connect an environment to see limits."));
  const limits = app.texts();
  await expect(limits).toContain("Connect an environment to see limits.");
  await expect(limits).toContain("All environments");
  await expect(limits).not.toContain("Past 24h");
  await expect(limits).not.toContain("Connect an environment to see usage.");
}, 90_000);

test("the sidebar offers no Pull requests entry until an environment has delivered its config", async () => {
  // usePullRequestsSupported: some environment has a serverConfig. A fresh, disconnected app has none.
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await expect(app.shows("label:Usage")).toBe(true);
  await expect(app.shows("label:Pull requests")).toBe(false);
});

test("clearing a sidebar search restores the empty list", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.type("label:Search threads", "missing");
  await expect(app.texts()).toContain("No threads found");
  await app.press("label:Clear thread search");
  await expect(app.value("label:Search threads")).toBe("");
  await expect(app.texts()).not.toContain("No threads found");
});

test("every ported settings panel shows its own rows", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  // Panel name -> a row only that panel has (from settingsPanels.ts).
  const panels: [string, string][] = [
    ["Chat", "Rich text composer"],
    ["Diffs & pull requests", "Hide whitespace changes"],
    ["Threads", "Auto-settle merged threads"],
    ["Maintenance", "Keep awake while agents work"],
    ["About", "Open source licenses"],
    // These panels render live state or explicitly describe unavailable work.
    ["Keybindings", "Sidebar: Toggle"],
    ["Scheduled tasks", "Scheduled tasks"],
    ["Archive", "Connect an environment to see archived threads."],
  ];
  for (const [name, row] of panels) {
    await app.keyboard.press("mod+,");
    await app.wait(60);
    await app.press(`text:${name}`);
    await app.waitUntil(() => app.texts().includes(row));
    await expect(app.texts()).toContain(row);
    await app.press("label:Close settings");
    await app.wait(60);
  }
}, 180_000);

test("a select switches to the option it is given", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.wait(60);
  // Time format defaults to System default (packages/contracts).
  await expect(app.shows("id:Time format = locale")).toBe(true);
  await app.press("id:Time format = locale");
  await app.wait(80);
  await app.press("label:12-hour");
  await app.wait(80);
  await expect(app.shows("id:Time format = 12-hour")).toBe(true);
});

test("confirmation switches carry the web's defaults and can be changed", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.waitFor("id:Delete confirmation (on)");
  await app.press("label:Delete confirmation");
  await app.waitFor("id:Delete confirmation (off)");
});

test("New thread opens an empty draft", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.press("label:New thread");
  await app.waitFor("id:composer-prompt");
  await expect(app.texts()).toContain("New thread");
  await expect(app.value("id:composer-prompt")).toBe("");
});

test("Open settings in the palette opens General", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+k");
  await app.waitFor("text:Open settings");
  await app.press("text:Open settings");
  await app.waitFor("text:In-app notifications");
  await expect(app.texts()).not.toContain("Recent Threads");
});

test("Add project with no environment offers to connect one", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.press("label:Add project");
  await app.waitFor("text:No connected environment can add a project");
  await app.press("text:Connect an environment");
  await app.waitFor("label:Add environment");
});

test("sidebar search reports when there are no matching threads", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.type("label:Search threads", "not found");
  await expect(app.texts()).toContain("No threads found");
});

test("mod+b hides the sidebar and shows it again", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await expect(app.shows("label:New thread")).toBe(true);
  await app.keyboard.press("mod+b");
  await expect(app.shows("label:New thread")).toBe(false);
  await app.keyboard.press("mod+b");
  await expect(app.shows("label:New thread")).toBe(true);
});

test("a collapsed sidebar can be brought back from the header", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.press("label:Toggle main sidebar");
  await app.waitUntil(() => !app.shows("label:New thread"));
  await expect(app.shows("label:New thread")).toBe(false);
  await app.press("label:Toggle main sidebar");
  await app.waitFor("label:New thread");
  await expect(app.shows("label:New thread")).toBe(true);
});

test("mod+, replaces usage instead of opening settings under it", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+u");
  await app.wait(80);
  await expect(app.texts()).toContain("Connect an environment to see limits.");
  await app.keyboard.press("mod+,");
  await app.wait(80);
  await expect(app.texts()).toContain("In-app notifications");
  await expect(app.texts()).not.toContain("Connect an environment to see limits.");
});

test("starting a second draft does not reuse the first draft text", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.press("label:New thread");
  await app.waitFor("id:composer-prompt");
  await app.type("id:composer-prompt", "First draft");
  await app.waitFor("id:composer-prompt >> text:First draft");
  await app.press("label:New thread >> nth=0");
  await app.waitUntil(() => app.value("id:composer-prompt") === "");
  await expect(app.value("id:composer-prompt")).toBe("");
});

test("settings search opens the panel that owns the row", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.waitFor("text:In-app notifications");
  await app.type("Search settings", "Rich text composer");
  const result = "id:Settings result composer-rich-text (active)";
  await app.waitFor(result);
  await app.press(result);
  await app.waitUntil(() => !app.texts().includes("In-app notifications"));
  await expect(app.texts()).toContain("Rich text composer");
});

test("the default chords for new thread and usage run through the command registry", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+n");
  await app.waitFor("id:composer-prompt");
  await expect(app.value("id:composer-prompt")).toBe("");
  await app.keyboard.press("mod+u");
  await app.waitFor("text:Usage");
  await app.keyboard.press("mod+u");
  await app.waitFor("id:composer-prompt");
});

test("Escape closes settings", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.wait(60);
  await expect(app.shows("label:Close settings")).toBe(true);
  await app.keyboard.press("escape");
  await app.wait(60);
  await expect(app.shows("label:Close settings")).toBe(false);
});

test("Escape closes an open select first, then settings", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.wait(60);
  await app.press("label:Thread notifications = off");
  await expect(app.texts()).toContain("Notifications with sound");
  await app.keyboard.press("escape");
  await app.wait(60);
  await expect(app.shows("label:Close settings")).toBe(true);
  await app.keyboard.press("escape");
  await app.wait(60);
  await expect(app.shows("label:Close settings")).toBe(false);
});
