import { expect, open, test } from "nsh/test";

test("a group of six subagents reads 2 working, 4 done and lists each child once opened", async () => {
  const app = await open("./SubagentFixture.tsx", { width: 900, height: 800, clock: {} });
  await expect(app.texts()).toContain("Used kimi-cu integration");
  await expect(app.texts()).toContain("6 subagents");
  await expect(app.texts()).toContain("2 working · 4 done");
  await expect(app.texts()).toContain("+3");
  await expect(app.texts()).toContain("1m 12s");
  await expect(app.texts()).not.toContain("Debug sidebar missing threads live");
  await expect(app.texts()).toContain("Thinking");
  await app.press("label:6 subagents");
  const texts = app.texts();
  const titles = ["Debug sidebar missing threads live", "Chat column layout and header banners", "Theme token audit for unknown classes", "Composer menus and remaining items", "Settings remaining panels and fidelity", "Live turn detail and per-tool rows"];
  const positions = titles.map((title) => texts.indexOf(title));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  expect(app.count("id:subagent-dot-success")).toBe(4);
  expect(app.count("id:subagent-dot-info")).toBe(2);
  await expect(app.texts()).toContain("Running find /private/tmp /tmp /Users/jkneen/Documents/Gi");
  await expect(app.texts()).toContain("Running");
  await expect(app.texts()).toContain("19s");
  await expect(app.texts()).toContain("15s");
  await expect(app.texts()).toContain("0s");
  await app.press("label:6 subagents");
  await expect(app.texts()).not.toContain("Chat column layout and header banners");
});

test("the counts and a row's status follow the live record of the child", async () => {
  const app = await open("./SubagentFixture.tsx", { width: 900, height: 800, clock: {} });
  await app.press("label:6 subagents");
  await app.press("id:finish");
  await expect(app.texts()).toContain("1 working · 5 done");
  await expect(app.texts()).toContain("Settings panels audited.");
  expect(app.count("id:subagent-dot-success")).toBe(5);
});
