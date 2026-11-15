import { expect, open, test } from "nsh/test";
import { contextStripCompactFor, resolveContextStripLabelsCompact } from "./contextStripCompact";

test("labels collapse when they need more than the strip has, and come back only with 16pt to spare", () => {
  expect(resolveContextStripLabelsCompact({ compact: false, neededWidth: 301, availableWidth: 300 })).toBe(true);
  expect(resolveContextStripLabelsCompact({ compact: false, neededWidth: 300, availableWidth: 300 })).toBe(false);
  expect(resolveContextStripLabelsCompact({ compact: true, neededWidth: 290, availableWidth: 300 })).toBe(true);
  expect(resolveContextStripLabelsCompact({ compact: true, neededWidth: 284, availableWidth: 300 })).toBe(false);
});

test("the strip is compact when the labels' growth outruns the spacer and the gap it replaces", () => {
  const labels = [{ current: 60, natural: 100 }, { current: 0, natural: 80 }];
  expect(contextStripCompactFor({ compact: false, spacerWidth: 100, labels })).toBe(true);
  expect(contextStripCompactFor({ compact: false, spacerWidth: 112, labels })).toBe(false);
  expect(contextStripCompactFor({ compact: false, spacerWidth: 111, labels })).toBe(true);
  expect(contextStripCompactFor({ compact: true, spacerWidth: 100, labels })).toBe(true);
});

test("a narrow strip shows icons only, a wide one its labels", async () => {
  const app = await open("./ContextStripFixture.tsx", { width: 800, height: 300, platform: "macos" });
  await app.waitUntil(() => app.texts().includes("labels"));
  await app.press("text:Narrow");
  await app.waitUntil(() => app.texts().includes("compact"), { timeout: 8000 });
  await app.press("text:Wide");
  await app.waitUntil(() => app.texts().includes("labels"), { timeout: 8000 });
});
