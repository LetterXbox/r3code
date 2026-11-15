import { expect, open, test } from "nsh/test";
import { asTimestampFormat, formatDayAwareTimestamp } from "../timestampFormat";

test("a finished turn shows one Worked for row above the reply; it expands to the grouped work", async () => {
  const app = await open("./TurnFoldFixture.tsx", { width: 900, height: 600, clock: {} });
  await expect(app.texts()).toContain("Worked for 13s");
  await expect(app.texts()).toContain("All fixed.");
  await expect(app.texts()).not.toContain("Ran 2 commands");
  await app.press("label:Worked for 13s");
  await expect(app.texts()).toContain("Ran 2 commands");
  await expect(app.texts()).toContain("All fixed.");
  await app.press("label:Worked for 13s");
  await expect(app.texts()).not.toContain("Ran 2 commands");
});

test("a find match inside a collapsed fold opens the fold", async () => {
  const app = await open("./TurnFoldFixture.tsx", { width: 900, height: 600, clock: {} });
  await expect(app.texts()).not.toContain("Ran 2 commands");
  await app.press("id:find-hidden");
  await app.waitFor("text:Ran 2 commands");
});

test("the fold row carries the time its turn started at its right edge", async () => {
  const app = await open("./TurnFoldFixture.tsx", { width: 900, height: 600, clock: {} });
  const stamp = formatDayAwareTimestamp(1000, asTimestampFormat(undefined));
  await expect(stamp.length > 0).toBe(true);
  await expect(app.texts()).toContain(stamp);
});
