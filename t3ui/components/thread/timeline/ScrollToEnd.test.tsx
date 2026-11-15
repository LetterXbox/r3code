import { expect, open, test } from "nsh/test";

const options = { width: 900, height: 600, clock: {} } as const;

test("opened at the end, the pill is hidden", async () => {
  const app = await open("./ScrollToEndFixture.tsx", options);
  await expect(app.shows("text:Message number 59")).toBe(true);
  await expect(app.shows("label:Scroll to end")).toBe(false);
});

test("scrolling up shows Scroll to end, pressing it returns to the bottom and hides it", async () => {
  const app = await open("./ScrollToEndFixture.tsx", options);
  await app.scroll("id:Thread messages", -3000);
  await app.waitFor("label:Scroll to end");
  await expect(app.shows("text:Message number 59")).toBe(false);
  await app.press("label:Scroll to end");
  await app.waitFor("text:Message number 59");
  await expect(app.shows("label:Scroll to end")).toBe(false);
});

test("while following, a new reply stays in view; once scrolled away it does not jump", async () => {
  const app = await open("./ScrollToEndFixture.tsx", options);
  await app.press("label:Append reply");
  await app.waitFor("text:Message number 60");
  await app.scroll("id:Thread messages", -3000);
  await app.waitFor("label:Scroll to end");
  await app.press("label:Append reply");
  await expect(app.shows("text:Message number 61")).toBe(false);
  await app.press("label:Scroll to end");
  await app.waitFor("text:Message number 61");
});

test("the pill carries what is waiting and how many messages are queued", async () => {
  const app = await open("./ScrollToEndFixture.tsx", options);
  await app.scroll("id:Thread messages", -3000);
  await app.waitFor("label:Scroll to end");
  await expect(app.texts()).toContain("\u00b7 Subagent waiting \u00b7 2 queued");
});

