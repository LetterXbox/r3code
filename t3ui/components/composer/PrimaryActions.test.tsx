import { expect, open, test } from "nsh/test";

test("a running turn with an empty draft offers Stop, and content turns it into Steer then Queue by setting", async () => {
  const app = await open("./PrimaryActionsFixture.tsx", { width: 500, height: 400, platform: "macos" });
  await expect(app.shows("label:Stop generation")).toBe(true);
  await app.press("label:Stop generation");
  await expect(app.texts()).toContain("log:interrupt");
  await app.press("label:has content");
  await expect(app.shows("label:Steer message")).toBe(true);
  await app.press("label:queue mode");
  await expect(app.shows("label:Queue message")).toBe(true);
  await expect(app.shows("label:Stop generation")).toBe(false);
});

test("stop is disabled when the environment cannot be operated", async () => {
  const app = await open("./PrimaryActionsFixture.tsx", { width: 500, height: 400, platform: "macos" });
  await app.press("label:disconnect");
  let refused = "";
  try { await app.press("label:Stop generation"); } catch (cause) { refused = String(cause); }
  expect(refused).toContain("disabled");
  expect(app.texts()).toContain("log:none");
});

test("idle shows Submit message, a held queue offers Resume thread, and editing a queued message offers Update", async () => {
  const app = await open("./PrimaryActionsFixture.tsx", { width: 500, height: 400, platform: "macos" });
  await app.press("label:idle");
  await expect(app.shows("label:Submit message")).toBe(true);
  await app.press("label:held");
  await expect(app.shows("label:Resume thread")).toBe(true);
  await app.press("label:Resume thread");
  await expect(app.texts()).toContain("log:resume");
  await app.press("label:edit");
  await expect(app.shows("label:Update queued message")).toBe(true);
});

test("a stale conversation offers a Compact chip that toggles to Keep, and never beside Resume or an edit", async () => {
  const app = await open("./PrimaryActionsFixture.tsx", { width: 500, height: 400, platform: "macos" });
  await app.press("label:idle");
  await app.press("label:stale");
  await expect(app.shows("label:Compact 212k tokens of history before sending")).toBe(true);
  await expect(app.texts()).toContain("Compact");
  await expect(app.texts()).toContain("212k");
  await app.press("label:Compact 212k tokens of history before sending");
  await app.waitUntil(() => app.texts().includes("Keep"));
  await app.press("label:held");
  await expect(app.shows("label:Compact 212k tokens of history before sending")).toBe(false);
});

test("the button colour per state: neutral while nothing can be sent, the action colour when sendable, destructive for Stop", async () => {
  const { primaryTone } = await import("./ComposerPrimaryActions");
  await expect(primaryTone("submit", true)).toBe("neutral");
  await expect(primaryTone("submit", false)).toBe("action");
  await expect(primaryTone("steer", false)).toBe("action");
  await expect(primaryTone("queue", false)).toBe("action");
  await expect(primaryTone("update", false)).toBe("action");
  await expect(primaryTone("resume", false)).toBe("action");
  await expect(primaryTone("resume", true)).toBe("neutral");
  await expect(primaryTone("stop", false)).toBe("stop");
});
