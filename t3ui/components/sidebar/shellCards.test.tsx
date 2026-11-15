import { expect, open, test } from "nsh/test";

const options = { width: 340, height: 700, platform: "macos" as const };

test("a fork is listed; side chats, delegated tasks and provider subagents get no row", async () => {
  const app = await open("./ShellCardsFixture.tsx", options);
  await expect(app.texts()).toContain("Greeting fork");
  await expect(app.texts()).toContain("Root thread");
  await expect(app.texts()).not.toContain("Side chat");
  await expect(app.texts()).not.toContain("Delegated task");
  await expect(app.texts()).not.toContain("Provider subagent");
});

test("cards show the provider marks and an unread finished thread reads Done", async () => {
  const app = await open("./ShellCardsFixture.tsx", options);
  await expect(app.texts()).toContain("Done");
  // Root ran on Codex then Claude: two marks; the fork ran on Codex only: one.
  await expect(app.count("label:Claude provider")).toBe(1);
  await expect(app.count("label:Codex provider")).toBe(2);
});
