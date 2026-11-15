import { expect, open, test } from "nsh/test";

test("each closed gate says what the reference says and offers its action", async () => {
  const app = await open("./McpWizardFixture.tsx", { width: 900, height: 1200 });
  for (const text of ["Sign in to T3 Connect", "Apps like Poke and Claude run in the cloud. They need a public address to reach Studio.", "T3 Connect gives Studio that address. Each app still needs your approval."]) await expect(app.texts()).toContain(text);
  await app.press("label:Sign in to T3 Connect");
  await expect(app.texts()).toContain("log sign in");
  await app.press("label:g-disc");
  await expect(app.texts()).toContain("Connect to Studio first.");
  await app.press("label:g-disc-off");
  await expect(app.texts()).toContain("Studio's T3 Connect is offline");
  await app.press("label:Check again");
  await app.press("label:g-update");
  await expect(app.texts()).toContain("Update R3 Code on Studio");
  await app.press("label:g-norelay");
  await expect(app.texts()).toContain("This device needs the View relay permission on Studio.");
  await app.press("label:g-error");
  await expect(app.texts()).toContain("Can't check T3 Connect on Studio");
  await expect(app.texts()).toContain("Could not reach T3 Connect.");
  await app.press("label:g-turnon");
  for (const text of ["Turn on T3 Connect for Studio", "Studio gets a public https address, with no router setup.", "Only apps you approve can use it. You can turn it off in Settings."]) await expect(app.texts()).toContain(text);
  await app.press("label:Turn on");
  await app.press("label:g-offline");
  for (const text of ["Studio's T3 Connect is offline", "No live connection.", "Fix: Restart T3 Code."]) await expect(app.texts()).toContain(text);
  await app.press("label:g-checking");
  await expect(app.texts()).toContain("Checking T3 Connect…");
});

test("the App step lists the visible apps and Something else", async () => {
  const app = await open("./McpWizardFixture.tsx", { width: 900, height: 1200 });
  await app.press("label:stage-app");
  for (const name of ["Which app?", "Poke", "Claude", "ChatGPT", "Grok Bot", "Muse", "Instinct", "OpenClaw", "Hermes Agent", "Something else…"]) await expect(app.texts()).toContain(name);
  await expect(app.texts()).not.toContain("Gemini");
  await app.press("label:Claude");
  await expect(app.texts()).toContain("choice Claude");
});

test("the Access step explains every level and greys out the ones this device cannot grant", async () => {
  const app = await open("./McpWizardFixture.tsx", { width: 900, height: 1200 });
  await app.press("label:stage-access");
  for (const text of ["What can Claude do?", "Read only", "Supervised", "Auto-accept edits", "Auto", "Full access", "This device cannot grant this on Studio.", "Ask before commands and file changes."]) await expect(app.texts()).toContain(text);
});

test("the Connect step hands the URL to the app and mints a code on request", async () => {
  const app = await open("./McpWizardFixture.tsx", { width: 900, height: 1200 });
  await app.press("label:stage-connect");
  for (const text of ["Open in Claude", "URL", "https://prod.t3coderelay.com/mcp", "Code to approve Auto", "Get code", "Set up another way"]) await expect(app.texts()).toContain(text);
  await app.press("label:Get code");
  await expect(app.texts()).toContain("AUTO-ABCDEFGHJKLM");
  await app.press("label:Set up another way");
  for (const text of ["1. In Claude, open Customize, then Connectors.", "Back to one click", "Claude help"]) await expect(app.texts()).toContain(text);
});
