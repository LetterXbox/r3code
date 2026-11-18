import { expect, open, test } from "nsh/test";

type Frame = { x: number; y: number; width: number; height: number };
const frameOf = (texts: string[], name: string): Frame | null => {
  const line = texts.find((text) => text.startsWith(`${name}:{`));
  return line ? (JSON.parse(line.slice(name.length + 1)) as Frame) : null;
};

test("the terminal's action buttons sit outside the terminal's frame, so its web view cannot cover them", async () => {
  const app = await open("./TerminalToolbarFixture.tsx", { width: 1000, height: 700, platform: "macos" });
  await app.waitFor("label:Terminal actions strip");
  await app.waitUntil(() => frameOf(app.texts(), "actions") !== null && frameOf(app.texts(), "terminal") !== null);
  const actions = frameOf(app.texts(), "actions")!;
  const terminal = frameOf(app.texts(), "terminal")!;
  // Stacked in one column: the terminal starts where the strip ends.
  await expect(terminal.y).toBeGreaterThanOrEqual(actions.y + actions.height);
  await expect(app.shows("label:Terminal actions")).toBe(true);
});
