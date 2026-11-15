// The shell mappings the app forwards while the drawer wants the keyboard (the table of terminalTyping.ts), same as the page's own.
import { expect, open, test } from "nsh/test";

test("Option/Cmd+Arrow, Cmd+Backspace and Cmd+K reach the shell as the reference's sequences", async () => {
  const app = await open("./TerminalTypingFixture.tsx", { platform: "macos" });
  await app.press("label:Want");
  await app.keyboard.press("alt+left");
  await app.keyboard.press("alt+right");
  await app.keyboard.press("cmd+left");
  await app.keyboard.press("cmd+right");
  await app.keyboard.press("cmd+backspace");
  await app.keyboard.press("cmd+k");
  await app.waitFor("text:pty=[\\u001bb\\u001bf\\u0001\\u0005\\u0015\\f]");
});
