import { expect, open, test } from "nsh/test";
import { webViewLive } from "./components/terminal/webviewLive";

// The Ghostty renderer is a canvas inside a WebView page. The headless engine
// never loads a WebView's page (no scripts run, so the terminal never reports
// "ready"), so these checks only run in a real window:
//   nsh test t3ui/terminal-renderer.test.tsx --target macos
// Headless they are reported as skipped, not passed.
const live = await webViewLive("./components/terminal/WebViewLiveProbe.tsx");
const windowed = live ? test : test.skip;

windowed("the bundled Ghostty renderer paints terminal output", async () => {
  const app = await open("./TerminalFixture.tsx", { width: 800, height: 500 });
  await app.waitFor("text:painted", { timeout: 10000 });
  await expect(app.texts()).toContain("painted");
}, 90000);

windowed("terminal key events reach the input bridge", async () => {
  const app = await open("./TerminalFixture.tsx", { width: 800, height: 500 });
  await app.waitFor("text:painted", { timeout: 10000 });
  await app.press("label:Send test key");
  await app.waitFor("text:input:a", { timeout: 5000 });
  await expect(app.texts()).toContain("input:a");
  await app.press("label:Send test control key");
  await app.waitFor("text:input:ctrl-c", { timeout: 5000 });
  await expect(app.texts()).toContain("input:ctrl-c");
}, 90000);

test("the terminal fixture loads its bundled renderer document", async () => {
  const app = await open("./TerminalFixture.tsx", { width: 800, height: 500 });
  await app.waitFor("label:Terminal canvas", { timeout: 5000 });
});
