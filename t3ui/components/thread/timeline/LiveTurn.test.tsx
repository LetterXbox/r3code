import { expect, open, test } from "nsh/test";

test("the running turn shows Working for, the reasoning text and Running cat, in that order", async () => {
  const app = await open("./LiveTurnFixture.tsx", { width: 900, height: 700, clock: {} });
  const texts = app.texts();
  expect(texts.some((text) => text.startsWith("Working for 19s"))).toBe(true);
  expect(texts.some((text) => text.startsWith("I'm checking whether we're running the current server code"))).toBe(true);
  expect(texts).toContain("Running cat");
  // Row order on screen, top to bottom: the prompt, the working row, then the live row (thought above the tool line).
  expect(texts).toContain("order: message:u1 > working > live-activity");
});

test("when the turn ends the live rows give way to the folded Worked for row", async () => {
  const app = await open("./LiveTurnFixture.tsx", { width: 900, height: 700, clock: {} });
  await app.press("label:Finish turn");
  await expect(app.texts()).not.toContain("Running cat");
  expect(app.texts().some((text) => text.startsWith("Working for"))).toBe(false);
});

test("pressing the live activity opens the group's entries", async () => {
  const app = await open("./LiveTurnFixture.tsx", { width: 900, height: 700, clock: {} });
  await app.press("label:Expand live activity");
  await expect(app.shows("label:Collapse live activity")).toBe(true);
  await expect(app.texts()).toContain("/bin/zsh -lc 'cat /tmp/dist-info.json'");
  await app.press("label:Expand Command");
  await expect(app.texts()).toContain("$ /bin/zsh -lc 'cat /tmp/dist-info.json'");
});
