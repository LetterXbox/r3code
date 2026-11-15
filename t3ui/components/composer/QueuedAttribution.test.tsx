import { expect, open, test } from "nsh/test";

test("queued rows wear their attribution and show context chips as labels (QueuedRunsControl QueuedMessage)", async () => {
  const app = await open("./QueuedAttributionFixture.tsx", { width: 700, height: 600, platform: "macos" });
  await expect(app.texts()).toContain("Sent by T3 Code");
  await expect(app.texts()).toContain("see notes.txt please");
  // An agent's queued turn folds under its sender (no shell title known here: "Agent").
  await expect(app.texts()).toContain("Agent");
  await expect(app.texts()).not.toContain("more detail");
  await app.press("label:Agent: Summarise line one");
  await app.waitUntil(() => app.texts().some((text) => text.includes("more detail")));
});
