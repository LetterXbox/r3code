import { expect, open, test } from "nsh/test";

test("sending while the run is starting queues the message and shows no error", async () => {
  const app = await open("./SendIntentFixture.tsx", { width: 500, height: 300, platform: "macos" });
  await expect(app.shows("label:Submit message")).toBe(true);
  await app.press("label:Submit message");
  await app.waitUntil(() => app.texts().includes("queued:1"));
  await expect(app.texts()).toContain("log:sent:auto");
  await expect(app.texts()).toContain("error:none");
});

test("sending while the run is running steers it", async () => {
  const app = await open("./SendIntentFixture.tsx", { width: 500, height: 300, platform: "macos" });
  await app.press("label:run running");
  await expect(app.shows("label:Steer message")).toBe(true);
  await app.press("label:Steer message");
  await app.waitUntil(() => app.texts().includes("log:sent:steer"));
  await expect(app.texts()).toContain("error:none");
});
