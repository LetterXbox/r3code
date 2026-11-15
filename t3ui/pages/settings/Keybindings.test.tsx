import { expect, open, test } from "nsh/test";

// The panel re-renders its whole catalog after each change, which can take longer than one press's settle on a loaded
// machine: every step below waits for the state it caused before it reads or presses anything that depends on it.
type App = Awaited<ReturnType<typeof open>>;
const shown = (app: App, text: string) => app.waitUntil(() => app.texts().includes(text));
const gone = (app: App, text: string) => app.waitUntil(() => !app.texts().includes(text));
const connect = async (app: App) => { await app.press("label:Connect fixture"); await gone(app, "Connect an environment to change keybindings."); };
const search = async (app: App, text: string) => { await app.type("label:Search keybindings", text); await gone(app, "Command Palette: Toggle"); };
const called = (app: App, match: (text: string) => boolean) => app.waitUntil(() => app.texts().some(match));

test("the keybinding list is the web's grouped catalog with a search field", async () => {
  const app = await open("./KeybindingsFixture.tsx", { width: 1100, height: 6000 });
  for (const text of ["Navigation", "Threads", "Composer", "Sidebar: Toggle", "Right Panel: Toggle", "Connect an environment to change keybindings."]) { await shown(app, text); await expect(app.texts()).toContain(text); }
  await expect(app.shows("id:Keybinding sidebar.toggle = mod+b")).toBe(true);
  await app.type("label:Search keybindings", "dictation");
  await gone(app, "Sidebar: Toggle");
  await expect(app.texts()).toContain("Composer: Start or Finish Dictation");
  await expect(app.texts()).not.toContain("Sidebar: Toggle");
  await app.clear("label:Search keybindings");
  await app.type("label:Search keybindings", "zzzz");
  // The search icon's image decodes after the first frame on a loaded machine, so wait for the list rather than the keystroke.
  for (let attempt = 0; attempt < 40 && !(await app.texts()).includes("No keybindings match your search."); attempt += 1) await app.wait(100);
  await expect(app.texts()).toContain("No keybindings match your search.");
});

test("recording a chord and saving replaces the old binding on the server, and reset restores it", async () => {
  const app = await open("./KeybindingsFixture.tsx", { width: 1100, height: 2400 });
  await connect(app);
  await search(app, "Sidebar");
  await app.press("label:Edit shortcut for Sidebar: Toggle: ⌘ B");
  await shown(app, "Press shortcut");
  await expect(app.texts()).toContain("Press shortcut");
  await app.keyboard.press("mod+shift+e");
  await app.waitFor("id:Keybinding sidebar.toggle = mod+shift+e");
  await app.press("label:Save shortcut for Sidebar: Toggle");
  await shown(app, "Custom");
  await expect(app.texts()).toContain('server.upsertKeybinding {"command":"sidebar.toggle","key":"mod+shift+e","replace":{"command":"sidebar.toggle","key":"mod+b"}}');
  await expect(app.texts()).toContain("Custom");
  await app.press("label:Actions for Sidebar: Toggle");
  await app.press("label:Reset to default");
  await shown(app, 'server.upsertKeybinding {"command":"sidebar.toggle","key":"mod+b","replace":{"command":"sidebar.toggle","key":"mod+shift+e"}}');
  await expect(app.texts()).toContain('server.upsertKeybinding {"command":"sidebar.toggle","key":"mod+b","replace":{"command":"sidebar.toggle","key":"mod+shift+e"}}');
});

test("escape cancels recording and leaves the binding alone", async () => {
  const app = await open("./KeybindingsFixture.tsx", { width: 1100, height: 2400 });
  await connect(app);
  await search(app, "Sidebar");
  await app.press("label:Edit shortcut for Sidebar: Toggle: ⌘ B");
  await shown(app, "Press shortcut");
  await app.keyboard.press("escape");
  await gone(app, "Press shortcut");
  await expect(app.texts()).not.toContain("Press shortcut");
  await expect(app.shows("id:Keybinding sidebar.toggle = mod+b")).toBe(true);
});

test("Add keybinding opens a new binding row that records a chord and saves it without replacing anything", async () => {
  const app = await open("./KeybindingsFixture.tsx", { width: 1100, height: 2400 });
  await expect(app.enabled("label:Add keybinding")).toBe(false);
  await connect(app);
  await app.press("label:Add keybinding");
  await shown(app, "New keybinding");
  await expect(app.texts()).toContain("New keybinding");
  await expect(app.texts()).toContain("Unassigned");
  await expect(app.texts()).toContain("Command");
  await app.press("label:New keybinding command = ");
  await app.waitFor("label:Appearance: Cycle");
  await app.press("label:Appearance: Cycle");
  await app.waitFor("label:Keybinding for Appearance: Cycle");
  await app.press("label:Keybinding for Appearance: Cycle");
  await shown(app, "Press shortcut");
  await app.keyboard.press("mod+shift+9");
  await app.waitFor("id:New keybinding = mod+shift+9");
  await app.press("label:Save new keybinding");
  await called(app, (text) => text === 'server.upsertKeybinding {"command":"appearance.cycle","key":"mod+shift+9"}');
  await gone(app, "Press shortcut");
  await expect(app.texts()).not.toContain("Press shortcut");
});

test("the when clause of a row opens an expression editor that explains a bad clause and saves a good one", async () => {
  const app = await open("./KeybindingsFixture.tsx", { width: 1100, height: 2400 });
  await connect(app);
  await search(app, "Sidebar");
  await app.press("label:Edit when clause for Sidebar: Toggle");
  await app.waitFor("label:When expression");
  await expect(app.texts()).toContain("Always");
  await app.type("label:When expression", "terminalFocus &&");
  await shown(app, "Use variables with !, &&, ||, and parentheses.");
  await app.clear("label:When expression");
  await app.type("label:When expression", "!terminalFocus && mysteryFlag");
  await app.waitFor("label:Unknown condition: mysteryFlag");
  await app.press("label:Save shortcut for Sidebar: Toggle");
  await called(app, (text) => text === 'server.upsertKeybinding {"command":"sidebar.toggle","key":"mod+b","when":"!terminalFocus && mysteryFlag","replace":{"command":"sidebar.toggle","key":"mod+b"}}');
  const calls = await app.texts();
  await expect(calls.some((text) => text === 'server.upsertKeybinding {"command":"sidebar.toggle","key":"mod+b","when":"!terminalFocus && mysteryFlag","replace":{"command":"sidebar.toggle","key":"mod+b"}}')).toBe(true);
});

test("a shortcut is drawn as one keycap per key, and the when clause is a dropdown button", async () => {
  const app = await open("./KeybindingsFixture.tsx", { width: 1100, height: 2400 });
  await search(app, "Sidebar");
  await expect(app.texts()).toContain("⌘");
  await expect(app.texts()).toContain("B");
  await expect(app.texts()).not.toContain("⌘ B");
  await expect(app.shows("label:Edit when clause for Sidebar: Toggle")).toBe(true);
  await expect(app.shows("label:Open keybindings.json")).toBe(true);
});

test("the when builder adds a condition from the known variables and writes the clause back", async () => {
  const app = await open("./KeybindingsFixture.tsx", { width: 1100, height: 2400 });
  await connect(app);
  await search(app, "Sidebar");
  await app.press("label:Edit when clause for Sidebar: Toggle");
  await app.waitFor("label:Add condition >> nth=0");
  await app.press("label:Add condition >> nth=0");
  await app.waitFor("label:Condition = terminalFocus");
  await app.press("label:Negate terminalFocus");
  await app.press("label:Save shortcut for Sidebar: Toggle");
  await called(app, (text) => text.includes('"when":"!terminalFocus"'));
  const calls = await app.texts();
  await expect(calls.some((text) => text.includes('"when":"!terminalFocus"'))).toBe(true);
});

test("a failed save raises the web's error toast, and a session without settings:write is read-only", async () => {
  const app = await open("./KeybindingsFixture.tsx", { width: 1100, height: 2400 });
  await connect(app);
  await app.press("label:Fail fixture");
  await search(app, "Sidebar");
  await app.press("label:Edit shortcut for Sidebar: Toggle: ⌘ B");
  await shown(app, "Press shortcut");
  await app.keyboard.press("mod+shift+e");
  await app.waitFor("id:Keybinding sidebar.toggle = mod+shift+e");
  await app.press("label:Save shortcut for Sidebar: Toggle");
  await shown(app, "Unable to save keybinding");
  await expect(app.texts()).toContain("Unable to save keybinding");
  await expect(app.texts()).toContain("The keybinding was not saved.");
  await app.press("label:Deny fixture");
  await shown(app, "This connection can view keybindings but cannot change them.");
  await expect(app.texts()).toContain("This connection can view keybindings but cannot change them.");
});
