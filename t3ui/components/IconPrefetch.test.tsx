import { expect, open, test } from "nsh/test";

test("every icon prefetches without rejecting", async () => {
  const app = await open("./IconPrefetchFixture.tsx", { width: 400, height: 300, platform: "macos" });
  await app.waitFor("text:/^prefetched \\d+$/");
  await expect(app.texts().join("|")).not.toContain("pending");
});
