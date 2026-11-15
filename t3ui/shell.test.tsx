// The shell's overlays: the quit shortcut's hint pill and the keybindings reload toasts.
import { expect, open, test } from "nsh/test";

test("the quit shortcut shows the hold hint and a second press quits", async () => {
  const app = await open("./ShellFixture.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.press("label:Quit shortcut");
  await app.waitFor("text:Hold ⌘Q or press twice to quit");
  await expect(app.texts()).toContain("quits 0");
  await app.wait(300);
  await app.press("label:Quit shortcut");
  await app.waitFor("text:quits 1");
  await expect(app.texts()).not.toContain("Hold ⌘Q or press twice to quit");
});

test("a valid keybindings reload toasts once inside the cooldown", async () => {
  const app = await open("./ShellFixture.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.press("label:Reload ok");
  await app.waitFor("text:Keybindings updated");
  await expect(app.texts()).toContain("Keybindings configuration reloaded successfully.");
  await app.press("label:Dismiss notification");
  await app.press("label:Reload ok");
  await app.wait(200);
  await expect(app.texts()).not.toContain("Keybindings updated");
});

test("an invalid keybindings reload warns with the reason and an Open keybindings.json button", async () => {
  const app = await open("./ShellFixture.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.press("label:Reload bad");
  await app.waitFor("text:Invalid keybindings configuration");
  await expect(app.texts()).toContain("Unknown command");
  await app.press("label:Open keybindings.json");
  await app.waitFor("text:opened 1");
});

test("the Open keybindings.json button is disabled without a config file or an editor", async () => {
  const app = await open("./ShellFixture.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.press("label:Reload bad no editor");
  await app.waitFor("text:No editor case");
  await expect(app.enabled("label:Open keybindings.json")).toBe(false);
});
