import { expect, open, test } from "nsh/test";

test("working rows remain mounted as shell updates arrive", async () => {
  const app = await open("./WorkingShelfLiveFixture.tsx", { width: 320, height: 600, platform: "macos" });
  await app.wait(500);
  const seen = new Set<string>();
  for (let index = 0; index < 8; index++) {
    await app.wait(160);
    const texts = await app.texts();
    await expect(texts).toContain("Working");
    const row = texts.find((text: string) => text.startsWith("Live thread "));
    expect(Boolean(row)).toBe(true);
    if (row) seen.add(row);
  }
  expect(seen.size > 1).toBe(true);
});
