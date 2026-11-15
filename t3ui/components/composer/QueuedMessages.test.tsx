import { expect, open, test } from "nsh/test";

test("queued messages render as bubbles, in order, with Send now, edit and remove", async () => {
  const app = await open("./QueuedMessagesFixture.tsx", { width: 700, height: 600, platform: "macos" });
  await expect(app.texts()).toContain("first queued");
  await expect(app.texts()).toContain("second queued");
  await expect(app.shows("label:Send now >> nth=0")).toBe(true);
  await expect(app.shows("label:Edit queued message >> nth=0")).toBe(true);
  await expect(app.shows("label:Remove queued message >> nth=0")).toBe(true);
});

test("Send now steers the queued run into the active one, remove cancels it, edit loads it into the composer", async () => {
  const app = await open("./QueuedMessagesFixture.tsx", { width: 700, height: 600, platform: "macos" });
  await app.press("label:Send now >> nth=0");
  await app.waitUntil(() => app.texts().includes("calls:promote:thread:t1:run:thread:t1:ordinal:7:run:thread:t1:ordinal:6"));
  await app.press("label:Edit queued message >> nth=1");
  await app.waitUntil(() => app.texts().includes("draft:second queued"));
  await expect(app.texts()).toContain("Editing in the composer");
  await app.press("label:Cancel editing queued message");
  await app.waitUntil(() => app.texts().includes("draft:my draft"));
  await app.press("label:Remove queued message >> nth=0");
  await app.waitUntil(() => app.texts().some((text) => text.includes("cancel:thread:t1:run:thread:t1:ordinal:7")));
  await expect(app.texts()).not.toContain("first queued");
});
