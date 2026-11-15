import { expect, open, test } from "nsh/test";

test("the lane shows the provider alert, then the thread error with its nested message, each dismissible", async () => {
  const app = await open("./BannerLaneFixture.tsx", { width: 700, height: 700, platform: "macos" });
  await expect(app.texts()).toContain("Claude is unauthenticated");
  await expect(app.texts()).toContain("Open provider setup to sign in.");
  await expect(app.shows("label:Open provider setup")).toBe(true);
  await expect(app.shows("label:Refresh")).toBe(true);
  await expect(app.texts()).toContain("Overloaded, retry later.");
  await expect(app.shows("label:Show full error")).toBe(true);
  await app.press("label:Dismiss Claude provider error");
  await expect(app.shows("label:Dismiss Claude provider error")).toBe(false);
  await expect(app.texts()).toContain("Overloaded, retry later.");
});

test("the end of the timeline lists what needs you and the goal; the stack lists the notices machine first", async () => {
  const app = await open("./BannerLaneFixture.tsx", { width: 700, height: 700, platform: "macos" });
  await expect(app.texts()).toContain("Subagent needs input");
  await expect(app.texts()).toContain("Goal paused");
  await expect(app.shows("label:Open question")).toBe(true);
  await expect(app.shows("label:Resume")).toBe(true);
  await app.press("label:Open question");
  await expect(app.texts()).toContain("open c");
  await app.press("label:Resume");
  await expect(app.texts()).toContain("/goal resume");
  const titles = app.texts().filter((text) => ["Local is offline", "Usage limit reached", "Pi · Indexing", "Branch changed from feature"].includes(text));
  await expect(titles).toEqual(["Usage limit reached", "Local is offline", "Pi · Indexing", "Branch changed from feature"]);
});

test("a notice's action and dismiss run", async () => {
  const app = await open("./BannerLaneFixture.tsx", { width: 700, height: 700, platform: "macos" });
  await app.press("label:Reconnect");
  await expect(app.texts()).toContain("reconnect");
  await app.press("label:Restore branch");
  await expect(app.texts()).toContain("restore");
  await app.press("label:Dismiss branch change notice");
  await expect(app.texts()).toContain("dismissed branch");
});

test("a failed send raises the thread error ahead of the server's own, and dismissing it clears the slot", async () => {
  const app = await open("./BannerLaneFixture.tsx", { width: 700, height: 700, platform: "macos" });
  await expect(app.texts()).toContain("Overloaded, retry later.");
  await app.press("label:Fail a send");
  await expect(app.texts()).toContain("Failed to send message.");
  await expect(app.texts()).not.toContain("Overloaded, retry later.");
  await expect(app.texts()).toContain("local:Failed to send message.");
  await app.press("label:Dismiss error");
  await expect(app.texts()).toContain("local:none");
  await expect(app.texts()).not.toContain("Failed to send message.");
});

test("in a narrow chat area (right panel open) the provider alert stays inside the lane and keeps its dismiss", async () => {
  const app = await open("./BannerLaneNarrowFixture.tsx", { width: 700, height: 500, platform: "macos" });
  await expect(app.shows("label:Dismiss Claude provider warning")).toBe(true);
  await app.press("label:Dismiss Claude provider warning");
  await expect(app.shows("label:Dismiss Claude provider warning")).toBe(false);
});
