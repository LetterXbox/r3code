import { expect, open, test } from "nsh/test";

test("a long queue folds behind Show all, and Edit marks the row as being edited", async () => {
  const app = await open("./QueuedRunsFixture.tsx", { width: 700, height: 600, platform: "macos" });
  await expect(app.texts()).toContain("first");
  await expect(app.texts()).toContain("second");
  await expect(app.texts()).not.toContain("third");
  await expect(app.texts()).not.toContain("saving soon");
  await app.press("label:Show all 5 queued");
  await expect(app.texts()).toContain("fourth");
  await expect(app.shows("label:Show fewer")).toBe(true);
  await app.press("label:Edit queued message >> nth=0");
  await expect(app.texts()).toContain("Editing in the composer");
  await app.press("label:Cancel editing queued message");
  await expect(app.texts()).not.toContain("Editing in the composer");
});

test("Send now and remove take a message out of the queue", async () => {
  const app = await open("./QueuedRunsFixture.tsx", { width: 700, height: 600, platform: "macos" });
  await app.press("label:Send now >> nth=0");
  await expect(app.texts()).not.toContain("first");
  await app.press("label:Remove queued message >> nth=0");
  await expect(app.texts()).not.toContain("second");
});

test("a message not yet queued by the server shows a Saving row", async () => {
  const app = await open("./QueuedRunsFixture.tsx", { width: 700, height: 600, platform: "macos" });
  await app.press("label:Show all 5 queued");
  await expect(app.texts()).toContain("saving soon");
  await expect(app.texts()).toContain("Saving");
});
