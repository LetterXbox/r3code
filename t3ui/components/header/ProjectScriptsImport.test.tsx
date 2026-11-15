import { expect, open, test } from "nsh/test";

const size = { width: 400, height: 600, platform: "macos" } as const;

test("the actions menu offers only the t3.json scripts the project lacks, under From t3.json", async () => {
  const app = await open("./ProjectScriptsImportFixture.tsx", size);
  await app.waitFor("label:Script actions");
  await app.press("label:Script actions");
  await app.waitFor("text:From t3.json");
  await expect(app.shows("label:Import Lint")).toBe(true);
  await expect(app.shows("label:Import Another")).toBe(false);
  await expect(app.shows("label:Import test")).toBe(false);
  await expect(app.shows("label:Add project script")).toBe(true);
});

test("importing saves the script with the file's options", async () => {
  const app = await open("./ProjectScriptsImportFixture.tsx", size);
  await app.waitFor("label:Script actions");
  await app.press("label:Script actions");
  await app.press("label:Import Lint");
  await app.wait(150);
  const log = app.texts().join("|");
  await expect(log).toContain('"id":"lint","name":"Lint","command":"bun lint","icon":"lint","runOnWorktreeCreate":true,"async":false,"previewUrl":"http://localhost:3000","autoOpenPreview":true');
  await expect(log).toContain('"id":"test"');
});

test("a refused import opens the form with the script and the server's reason", async () => {
  const app = await open("./ProjectScriptsImportFixture.tsx", size);
  await app.waitFor("label:Fail the next save");
  await app.press("label:Fail the next save");
  await app.press("label:Script actions");
  await app.press("label:Import Lint");
  await app.waitFor("text:Add Action");
  await app.waitFor("text:settings are read-only");
  await expect(app.value("label:Script name")).toBe("Lint");
});

test("a shortcut the server refuses is the form's error, in the server's own words", async () => {
  const app = await open("./ProjectScriptsImportFixture.tsx", size);
  await app.waitFor("label:Script actions");
  await app.press("label:Script actions");
  await app.press("label:Add project script");
  await app.waitFor("label:Script name");
  await app.type("label:Script name", "Build");
  await app.type("label:Script command", "bun build");
  await app.press("label:Script keybinding");
  await app.keyboard.press("mod+b");
  await app.press("label:Save action");
  await app.waitFor("text:Unable to parse keybindings config at /h/keybindings.json: Unexpected token");
  await expect(app.texts().join("|")).toContain("server:server.upsertKeybinding");
  await expect(app.texts().join("|")).not.toContain("The action was saved, but its shortcut was not");
});
