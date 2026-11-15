// The drawer terminal gets the keys the app receives while it wants the keyboard (the host cannot focus its web view).
import { expect, open, test } from "nsh/test";

test("typed keys and named keys go to the terminal only while the drawer wants the keyboard", async () => {
  const app = await open("./TerminalTypingFixture.tsx");
  await app.keyboard.press("a");
  await expect(app.texts()).toContain("pty=[]");
  await app.press("label:Want");
  await app.keyboard.press("l");
  await app.keyboard.press("s");
  await app.keyboard.press("enter");
  await app.keyboard.press("ctrl+c");
  await app.waitFor("text:pty=[ls\\r\\u0003]");
  await app.press("label:Release");
  await app.keyboard.press("x");
  await expect(app.texts()).toContain("pty=[ls\\r\\u0003]");
});
