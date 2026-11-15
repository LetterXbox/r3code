import { expect, open, test } from "nsh/test";


test("each toast variant renders its title, description and controls", async () => {
  const app = await open("./ToastExtrasFixture.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.press("label:Variant success");
  await app.waitFor("text:Thread copied");
  await expect(app.texts()).toContain("The thread link is on the clipboard.");
  await expect(app.shows("label:Copy error")).toBe(false);
  await app.press("label:Dismiss notification");
  await app.waitUntil(() => !app.texts().includes("Thread copied"));

  await app.press("label:Variant error");
  await app.waitFor("text:Could not send message");
  // An error's description gets the copy button, inline at the end of the row (no action: inline layout).
  await expect(app.shows("label:Copy error")).toBe(true);
  await app.press("label:Dismiss notification");
  await app.waitUntil(() => !app.texts().includes("Could not send message"));

  await app.press("label:Variant action");
  await app.waitFor("text:Send failed");
  await app.press("label:Retry");
  await app.waitFor("text:log retry");
  await app.press("label:Dismiss notification");
  await app.waitUntil(() => !app.texts().includes("Send failed"));

  await app.press("label:Notify");
  await app.waitFor("text:Approval needed");
  await app.press("label:Dismiss notification");
  await app.waitUntil(() => !app.texts().includes("Approval needed"));
});

test("several toasts stack: the newest in front, the rest peek; hovering the stack opens it", async () => {
  const app = await open("./ToastExtrasFixture.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.press("label:Variant title only");
  await app.press("label:Variant warning");
  await app.press("label:Variant info");
  await app.waitFor("text:Appearance: Dark");
  // Closed stack: only the front toast's text is drawn.
  await expect(app.texts()).not.toContain("Saved");
  await app.hover("label:Notification stack");
  await app.waitFor("text:Saved");
  await expect(app.texts()).toContain("Keybindings file has errors");
});

test("a loading toast shows its spinner and stays", async () => {
  const app = await open("./ToastExtrasFixture.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.press("label:Variant loading");
  await app.waitFor("text:Cloning repository");
  await app.wait(5500);
  await expect(app.texts()).toContain("Cloning repository");
});

test("the pairing page shows the reference's copy, field, buttons and methods note", async () => {
  const app = await open("./ToastExtrasFixture.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.press("label:Show pairing");
  await app.waitFor("text:Pair with this environment");
  await expect(app.texts()).toContain("Enter a pairing token to start a session with this environment.");
  await expect(app.texts()).toContain("Pairing token");
  await expect(app.shows("label:Continue")).toBe(true);
  await expect(app.shows("label:Reload app")).toBe(true);
  await expect(app.texts()).toContain("This environment accepts one-time pairing tokens. Pairing links can open this page directly, or you can paste the token here.");
});

test("the pairing pending page and the refused-credential alert", async () => {
  const app = await open("./ToastExtrasFixture.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.press("label:Show pairing pending");
  await app.waitFor("text:Pairing with this environment");
  await expect(app.texts()).toContain("Validating the pairing link and preparing your session.");
  await expect(app.shows("label:Continue")).toBe(false);
  const again = await open("./ToastExtrasFixture.tsx", { width: 1280, height: 800, platform: "macos" });
  await again.press("label:Show pairing error");
  await again.waitFor("text:Pair with this environment");
  await expect(again.texts()).toContain("Authentication failed.");
});
