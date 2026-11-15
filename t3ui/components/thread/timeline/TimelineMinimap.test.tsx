import { expect, open, test } from "nsh/test";

const options = { width: 420, height: 800, platform: "macos" as const };

test("pressing the rail without hovering first navigates to a turn", async () => {
  const app = await open("./TimelineMinimapFixture.tsx", options);
  await app.press("label:Jump to message: User message");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("picked:user-")));
});

test("hovering the rail shows the turn's card, and a press scrolls to that turn", async () => {
  const app = await open("./TimelineMinimapFixture.tsx", options);
  expect(app.shows("label:In view")).toBe(true);
  expect(app.texts().some((text) => text.startsWith("Question number"))).toBe(false);
  await app.hover("label:Jump to message: User message");
  await app.waitUntil(() => app.shows("id:timeline-minimap-preview"));
  expect(app.texts().some((text) => text.startsWith("Question number"))).toBe(true);
  await app.press("label:Jump to message: Question number 6");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("picked:user-")));
});

test("the card reads the answer as plain text", async () => {
  const app = await open("./TimelineMinimapFixture.tsx", options);
  await app.hover("label:Jump to message: User message");
  await app.waitUntil(() => app.shows("id:timeline-minimap-preview"));
  expect(app.texts()).toContain("The answer to five with code and more text");
});

test("pressing the preview does not navigate the timeline", async () => {
  const app = await open("./TimelineMinimapFixture.tsx", options);
  await app.hover("label:Jump to message: User message");
  await app.waitFor("id:timeline-minimap-preview");
  await app.press("id:timeline-minimap-preview");
  await expect(app.texts()).toContain("picked:none");
});

test("the rail adds a strip when a message arrives", async () => {
  const app = await open("./TimelineMinimapFixture.tsx", options);
  await expect(app.shows("id:minimap-strip-user-new")).toBe(false);
  await app.press("text:Add message");
  await expect(app.shows("id:minimap-strip-user-new")).toBe(true);
  await expect(app.shows("id:minimap-strip-user-0")).toBe(true);
});

test("the full preview can overlap the message column and the rail still navigates", async () => {
  const app = await open("./TimelineMinimapNarrowFixture.tsx", options);
  await app.hover("label:Jump to message: User message");
  await app.waitFor("id:timeline-minimap-preview");
  await app.press("label:Jump to message: Second message");
  await app.waitUntil(() => app.texts().includes("picked:second"));
});

test("with the keyboard focus the rail previews turns with Up / Down / Home / End and Enter jumps", async () => {
  const app = await open("./TimelineMinimapFixture.tsx", options);
  // Tab moves through the fixture's buttons to the rail.
  for (let step = 0; step < 6 && !app.shows("id:timeline-minimap-preview"); step += 1) { await app.keyboard.press("tab"); await app.wait(50); }
  await app.waitUntil(() => app.shows("id:timeline-minimap-preview"));
  await app.keyboard.press("home");
  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("picked:user-")));
});

test("keeps the current turn strip highlighted when scrolled past the user prompt into its response", async () => {
  const app = await open("./TimelineMinimapFixture.tsx", options);
  expect(app.shows("label:In view")).toBe(true);
  await app.press("text:Response");
  await app.waitUntil(() => app.shows("label:In view"));
  expect(app.shows("label:In view")).toBe(true);
});
