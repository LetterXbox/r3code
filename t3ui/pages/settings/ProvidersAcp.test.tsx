import { expect, open, test } from "nsh/test";

const SIZE = { width: 1400, height: 1400 };

test("an ACP instance lists native sessions per project, imports, pages and deletes after confirming", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await app.press("label:Select Hopper");
  for (const value of ["Native sessions", "Resume agent-owned conversations as T3 threads."]) await expect(app.texts()).toContain(value);
  await app.press("label:List sessions");
  await expect(app.texts()).toContain("acp.sessions p1");
  await expect(app.texts()).toContain("Fix flaky test");
  await expect(app.texts()).toContain("Imported");
  await app.press("label:Import Fix flaky test");
  await expect(app.texts()).toContain("acp.import s-1");
  await expect(app.texts()).toContain("ACP session imported");
  await app.press("label:Load more");
  await expect(app.texts()).toContain("acp.sessions p1 cursor c2");
  await expect(app.texts()).toContain("Third");
  await app.press("label:Delete Third");
  await expect(app.shows("id:Confirm delete ACP session")).toBe(true);
  await app.press("label:Cancel");
  await expect(app.texts()).not.toContain("acp.delete s-3");
  await app.press("label:Delete Third");
  await app.press("label:Confirm delete ACP session");
  await expect(app.texts()).toContain("acp.delete s-3");
  await expect(app.texts()).toContain("ACP session deleted");
});

test("an ACP instance can sign out and configure routing with write-only headers", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await app.press("label:Select Hopper");
  await app.press("label:Log out");
  await expect(app.texts()).toContain("acp.logout acp_hopper");
  await expect(app.texts()).toContain("Agent providers");
  await app.press("label:List providers");
  await expect(app.texts()).toContain("acp.providers p1");
  await expect(app.texts()).toContain("openrouter");
  await expect(app.texts()).toContain("Configured");
  await app.type("id:input openrouter write-only headers JSON", "not json");
  await app.press("label:Save openrouter");
  await expect(app.texts().some((text) => text.startsWith("Invalid provider headers"))).toBe(true);
  await expect(app.texts()).not.toContain("acp.set openrouter openai https://openrouter.ai/api");
  await app.clear("id:input openrouter write-only headers JSON");
  await app.type("id:input openrouter write-only headers JSON", '{"X-Key":"abc"}');
  await app.press("label:Save openrouter");
  await expect(app.texts()).toContain('acp.set openrouter openai https://openrouter.ai/api {"X-Key":"abc"}');
  await app.press("label:Disable openrouter");
  await app.press("label:Confirm disable ACP provider");
  await expect(app.texts()).toContain("acp.disable openrouter");
});

test("a failed removal uninstalls nothing", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await app.press("label:Select Hopper");
  await app.press("label:Fail next write");
  await app.press("label:Delete instance acp_hopper");
  await expect(app.texts()).toContain("Remove the Hopper provider instance?");
  await app.press("label:Confirm delete provider");
  // The failed write is consumed by the removal itself, so nothing is uninstalled.
  await expect(app.texts()).not.toContain("acp.uninstall hopper");
});

test("a deleted managed ACP instance asks the server to uninstall its agent", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await app.press("label:Select Hopper");
  await app.press("label:Delete instance acp_hopper");
  await app.press("label:Confirm delete provider");
  await expect(app.texts()).toContain("mutate remove acp_hopper {}");
  await expect(app.texts()).toContain("acp.uninstall hopper");
});

test("turning off the provider text generation uses resets that selection in the same write", async () => {
  const app = await open("./ProviderFixture.tsx", SIZE);
  await app.press("label:Enable Codex");
  await expect(app.texts().some((text) => text.startsWith("mutate patch") && text.includes('"textGenerationModelSelection"') && text.includes('"gpt-6-luna"'))).toBe(true);
});
