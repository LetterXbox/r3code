// Renders the real window to a PNG so geometry and colour can be inspected.
// Only a real platform draws the window, so this file is run on its own:
//   ./run-visual.sh
import { open, test } from "nsh/test";

test("renders the shell", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.screenshot("t3ui/shot.png");
});

test("renders the command palette", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+k");
  await app.wait(80);
  await app.screenshot("t3ui/shot-palette.png");
});

test("renders settings", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  await app.wait(80);
  await app.screenshot("t3ui/shot-settings.png");
});

test("renders usage", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+u");
  await app.wait(120);
  await app.screenshot("t3ui/shot-usage.png");
});

test("renders pull requests", async () => {
  const app = await open("./PullRequestsFixture.tsx", { width: 1280, height: 800 });
  await app.waitFor("text:Pull request 1");
  await app.screenshot("t3ui/shot-pull-requests.png");
});
