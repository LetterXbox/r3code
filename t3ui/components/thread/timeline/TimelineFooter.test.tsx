import { expect, open, test } from "nsh/test";

test("the footer slot is the last item of the transcript and scrolls with it", async () => {
  const app = await open("./FooterFixture.tsx", { width: 700, height: 500, platform: "macos" });
  await app.waitUntil(() => app.texts().includes("queued footer item"));
  await expect(app.texts()).toContain("message 29");
});
