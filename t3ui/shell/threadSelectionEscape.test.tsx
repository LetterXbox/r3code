// chatRouteCommands `onKeyDown`: Escape clears the thread multi-selection.
import { expect, open, test } from "nsh/test";

test("Escape clears a thread selection, and does nothing without one", async () => {
  const app = await open("./ThreadSelectionEscapeFixture.tsx", { width: 400, height: 300, platform: "macos" });
  await app.keyboard.press("escape");
  await expect(app.texts()).toContain("selected none");
  await app.press("label:Select one");
  await app.press("label:Select two");
  await app.waitFor("text:selected one,two");
  await app.keyboard.press("escape");
  await app.waitFor("text:selected none");
  await app.press("label:Select two");
  await app.waitFor("text:selected two");
  await app.keyboard.press("escape");
  await app.waitFor("text:selected none");
});
