import { expect, open, test } from "nsh/test";
import { webViewLive } from "./webviewLive";

// The Ghostty terminal is a WebView page; the headless engine never loads it, so the terminal
// frame this test measures never appears. Only runs under a real window (./webviewLive.ts).
const live = await webViewLive("./WebViewLiveProbe.tsx");
const windowed = live ? test : test.skip;

type Frame = { x: number; y: number; width: number; height: number };
const frameOf = (texts: string[], name: string): Frame | null => {
  const line = texts.find((text) => text.startsWith(`${name}:{`));
  return line ? (JSON.parse(line.slice(name.length + 1)) as Frame) : null;
};

windowed("the terminal's action buttons sit outside the terminal's frame, so its web view cannot cover them", async () => {
  const app = await open("./TerminalToolbarFixture.tsx", { width: 1000, height: 700, platform: "macos" });
  await app.waitFor("label:Terminal actions strip");
  await app.waitUntil(() => frameOf(app.texts(), "actions") !== null && frameOf(app.texts(), "terminal") !== null);
  const actions = frameOf(app.texts(), "actions")!;
  const terminal = frameOf(app.texts(), "terminal")!;
  // Stacked in one column: the terminal starts where the strip ends.
  await expect(terminal.y).toBeGreaterThanOrEqual(actions.y + actions.height);
  await expect(app.shows("label:Terminal actions")).toBe(true);
});
