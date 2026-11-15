import { expect, open, test } from "nsh/test";

test("the branch toolbar under a long transcript stays on screen in a short window", async () => {
  const app = await open("./TimelineLayoutFixture.tsx", { width: 1280, height: 600, clock: {} });
  await expect(app.shows("text:Local checkout")).toBe(true);
  const text = app.texts().find((entry) => entry.startsWith("footer bottom"));
  expect(text).toBeDefined();
  expect(Number(text!.replace("footer bottom ", ""))).toBeLessThanOrEqual(600);
});

test("a one-word message is one line tall: the first and last block margins are cancelled", async () => {
  const app = await open("./TimelineLayoutFixture.tsx", { width: 1280, height: 600, clock: {} });
  const text = app.texts().find((entry) => entry.startsWith("markdown "));
  // text-sm leading-relaxed is about 23pt; with the 0.65rem top and bottom margins it was about 44.
  expect(Number(text!.replace("markdown ", ""))).toBeLessThan(30);
  const bubble = app.texts().find((entry) => entry.startsWith("bubble "))!.split(" ")[1].split("x").map(Number);
  // p-3 either side of that line, the hover action row and the pb-4 row gap: about 95 at most.
  expect(bubble[1]).toBeLessThan(100);
});
