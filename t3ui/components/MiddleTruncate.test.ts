// The reference's middle-truncate.test.ts cases, verbatim.
import { expect, test } from "nsh/test";
import { splitForMiddleTruncate } from "./MiddleTruncate";

test("keeps a short last path segment whole", () => {
  expect(splitForMiddleTruncate("feature/ui-polish")).toEqual({ head: "feature/", tail: "ui-polish" });
});
test("starts a long segment's tail on a word, not mid-word", () => {
  expect(splitForMiddleTruncate("t3/clone-repo-to-other-machine")?.tail).toBe("machine");
  expect(splitForMiddleTruncate("t3/investigate-release-build-times")?.tail).toBe("times");
});
test("falls back to an earlier word when the last one is too short", () => {
  expect(splitForMiddleTruncate("t3/compare-long-featurenames-ab")?.tail).toBe("featurenames-ab");
});
test("keeps the fixed tail when no word break is near", () => {
  expect(splitForMiddleTruncate("t3/abcdefghijklmnopqrstuvwxyz")?.tail).toBe("qrstuvwxyz");
});
test("respects an explicit tail length", () => {
  expect(splitForMiddleTruncate("t3/clone-repo-to-other-machine", 6)?.tail).toBe("achine");
});
test("a value too short to cut stays whole", () => {
  expect(splitForMiddleTruncate("main")).toBeNull();
});
test("textWasCut: a line no wider than its box is whole (a box can hug its text); a wrapped or wider one is cut", async () => {
  const { textWasCut } = await import("./MiddleTruncate");
  const line = (width: number) => ({ bounds: { size: { width } } });
  expect(textWasCut([line(70)], 300)).toBe(false);
  expect(textWasCut([line(80)], 80)).toBe(false);
  expect(textWasCut([line(208)], 80)).toBe(true);
  expect(textWasCut([line(40), line(10)], 300)).toBe(true);
});
test("a value that fits stays one text; one that overflows splits so its tail stays", async () => {
  const { open } = await import("nsh/test");
  const app = await open("./MiddleTruncateFixture.tsx");
  await app.waitFor("text:machine");
  expect(app.texts()).toContain("feature/b");
});
