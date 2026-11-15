import { expect, open, test } from "nsh/test";

test("default chords run the registered command and when-clauses pick between commands on one key", async () => {
  const app = await open("./RegistryFixture.tsx", { width: 600, height: 300 });
  await app.keyboard.press("mod+b");
  await expect(app.texts()).toContain("ran: sidebar");
  await app.keyboard.press("mod+n");
  await expect(app.texts()).toContain("ran: sidebar,chat.new");
  await app.press("label:Focus terminal");
  await app.keyboard.press("mod+n");
  await expect(app.texts()).toContain("ran: sidebar,chat.new,terminal.new");
});

test("a saved override re-binds live: the old chord stops and the new one runs", async () => {
  const app = await open("./RegistryFixture.tsx", { width: 600, height: 300 });
  await app.press("label:Rebind sidebar");
  await app.keyboard.press("mod+b");
  await expect(app.texts()).toContain("ran: ");
  await expect(app.texts()).not.toContain("ran: sidebar");
  await app.keyboard.press("mod+shift+e");
  await expect(app.texts()).toContain("ran: sidebar");
  await app.press("label:Reset config");
  await app.keyboard.press("mod+b");
  await expect(app.texts()).toContain("ran: sidebar,sidebar");
});

test("a handler that declines lets the next older handler of the command run", async () => {
  const app = await open("./RegistryFixture.tsx", { width: 600, height: 300 });
  await app.keyboard.press("mod+2");
  await expect(app.texts()).toContain("ran: declined jump,old jump");
});

test("F6 cycles the registered workspace areas and Shift+F6 goes back", async () => {
  const app = await open("./RegistryFixture.tsx", { width: 600, height: 300 });
  await app.keyboard.press("f6");
  await expect(app.texts()).toContain("ran: focus sidebar");
  await app.keyboard.press("f6");
  await expect(app.texts()).toContain("ran: focus sidebar,focus thread");
  await app.keyboard.press("shift+f6");
  await expect(app.texts()).toContain("ran: focus sidebar,focus thread,focus sidebar");
});

test("editableFocus stops mod+z (thread.undo) while a text field has the focus", async () => {
  const app = await open("./RegistryFixture.tsx", { width: 600, height: 300 });
  await app.keyboard.press("mod+z");
  await expect(app.texts()).toContain("ran: undo");
  await app.type("label:Text field", "x");
  await app.keyboard.press("mod+z");
  await expect(app.texts()).toContain("ran: undo");
  await expect(app.texts()).not.toContain("ran: undo,undo");
});
