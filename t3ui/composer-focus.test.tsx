// Keyboard focus on the full app: the composer holds the keyboard after a draft opens and after
// settings close, so typing lands in it (and never falls through to the system beep).
import { expect, open, test } from "nsh/test";

async function typeKeys(app: Awaited<ReturnType<typeof open>>, text: string) {
  for (const key of text) await app.keyboard.press(key);
}

test("opening a draft and typing lands in the composer", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+shift+n");
  await app.waitUntil(() => app.shows("id:composer-prompt"));
  await typeKeys(app, "hi");
  await app.waitUntil(() => app.value("id:composer-prompt") === "hi");
});

test("closing settings returns the keyboard to the composer", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+shift+n");
  await app.waitUntil(() => app.shows("id:composer-prompt"));
  await app.keyboard.press("mod+,");
  await app.keyboard.press("mod+,");
  await app.waitUntil(() => app.shows("id:composer-prompt"));
  await typeKeys(app, "ok");
  await app.waitUntil(() => app.value("id:composer-prompt") === "ok");
});

test("closing the palette returns the keyboard to the composer", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+shift+n");
  await app.waitUntil(() => app.shows("id:composer-prompt"));
  await app.keyboard.press("mod+k");
  await app.keyboard.press("escape");
  await typeKeys(app, "yo");
  await app.waitUntil(() => app.value("id:composer-prompt") === "yo");
});

test("with the add-project dialog open, typing is not redirected into the composer", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+shift+n");
  await app.waitUntil(() => app.shows("id:composer-prompt"));
  await app.press("label:Add project");
  await app.keyboard.press("shift+h");
  await app.keyboard.press("i");
  await app.wait(100);
  await expect(app.value("id:composer-prompt")).toBe("");
});
