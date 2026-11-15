import { expect, open, test } from "nsh/test";

const OPEN = { width: 800, height: 700 } as const;

test("a message from R3 Code says so above the bubble", async () => {
  const app = await open("./MessageVariantsFixture.tsx", OPEN);
  await expect(app.texts()).not.toContain("Sent by R3 Code");
  await app.press("label:Show T3 message");
  await expect(app.texts()).toContain("Sent by R3 Code");
  await expect(app.texts()).toContain("Retry the build");
});

test("a guest's message shows the guest's name and words, not the agent's wording", async () => {
  const app = await open("./MessageVariantsFixture.tsx", OPEN);
  await app.press("label:Show guest message");
  await expect(app.texts()).toContain("Sam");
  await expect(app.texts()).toContain("ship it");
  await expect(app.texts()).not.toContain("Sam says: ship it");
});

test("a steer carries the Steer marker, with its own tooltip when it was promoted from the queue", async () => {
  const app = await open("./MessageVariantsFixture.tsx", OPEN);
  await expect(app.shows("label:Steer")).toBe(false);
  await app.press("label:Show steer message");
  await expect(app.shows("label:Steer")).toBe(true);
  await expect(app.texts()).toContain("Steer");
  await app.press("label:Show promoted steer message");
  await expect(app.shows("label:Steer")).toBe(true);
});

test("an agent's message folds to its sender and first line, and opens on press", async () => {
  const app = await open("./MessageVariantsFixture.tsx", OPEN);
  await app.press("label:Show agent message");
  await expect(app.texts()).toContain("Planner agent");
  await expect(app.texts()).toContain("Please review");
  await expect(app.texts()).not.toContain("the plan");
  await expect(app.shows("label:Open thread")).toBe(true);
  await app.press("label:Planner agent: Please review");
  await expect(app.texts().some((text) => text.includes("the plan"))).toBe(true);
});

test("an automation prompt folds behind the Automation label and offers Open automation once open", async () => {
  const app = await open("./MessageVariantsFixture.tsx", OPEN);
  await app.press("label:Show automation message");
  await expect(app.texts()).toContain("Automation");
  await expect(app.texts()).toContain("Run nightly checks");
  await expect(app.shows("label:Open automation")).toBe(false);
  await app.press("label:Automation: Run nightly checks");
  await expect(app.shows("label:Open automation")).toBe(true);
});

test("a message that starts a new session or switches model draws a divider above it", async () => {
  const app = await open("./MessageVariantsFixture.tsx", OPEN);
  await app.press("label:Show new session message");
  await expect(app.texts()).toContain("New session");
  await app.press("label:Show model switch message");
  await expect(app.texts().some((text) => text.includes("→"))).toBe(true);
  await expect(app.texts()).not.toContain("New session");
});

test("a user message that failed wears its status", async () => {
  const app = await open("./MessageVariantsFixture.tsx", OPEN);
  await app.press("label:Show failed user message");
  await expect(app.shows("label:Message status")).toBe(true);
  await expect(app.texts()).toContain("failed");
});
