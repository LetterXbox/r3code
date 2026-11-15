import { expect, open, test } from "nsh/test";

const options = { width: 900, height: 600, clock: {} } as const;

test("a thread left in its history opens where it was left; one left at its end opens at its end", async () => {
  const app = await open("./PositionRestoreFixture.tsx", options);
  await app.waitFor("text:Thread a line 59");
  await app.scroll("id:Thread messages", -3000);
  await app.waitFor("label:Scroll to end");
  await expect(app.shows("text:Thread a line 59")).toBe(false);
  await app.press("label:Open thread b");
  await app.waitFor("text:Thread b line 59");
  await app.press("label:Open thread a");
  // Back in a, the reader is still in its history: not at its end.
  await app.waitUntil(() => app.texts().some((text) => /^Thread a line \d+$/.test(text)));
  await expect(app.shows("text:Thread a line 59")).toBe(false);
  await app.waitFor("label:Scroll to end");
  // b was left at its end: it opens there.
  await app.press("label:Open thread b");
  await app.waitFor("text:Thread b line 59");
});

test("a sent message pins near the top with anchored end space, and tool activity releases it to the end", async () => {
  const app = await open("./PositionRestoreFixture.tsx", options);
  await app.waitFor("text:Thread a line 59");
  await app.press("label:Send");
  await app.waitFor("id:Anchored end space");
  await app.waitFor("text:The message just sent");
  await app.press("label:Tool");
  await app.waitUntil(() => !app.shows("id:Anchored end space"));
});

test("a user scroll releases the sent-message anchor without trapping the gesture", async () => {
  const app = await open("./PositionRestoreFixture.tsx", options);
  await app.waitFor("text:Thread a line 59");
  await app.press("label:Send");
  await app.waitFor("id:Anchored end space");
  await app.scroll("id:Thread messages", -300);
  await app.waitUntil(() => !app.shows("id:Anchored end space"));
  await app.waitFor("label:Scroll to end");
});

test("a scroll immediately after switching threads stays in the new thread's history", async () => {
  const app = await open("./PositionRestoreFixture.tsx", options);
  await app.waitFor("text:Thread a line 59");
  await app.press("label:Open thread b");
  await app.scroll("id:Thread messages", -1800);
  await app.waitFor("label:Scroll to end");
  await expect(app.shows("text:Thread b line 59")).toBe(false);
  await app.waitUntil(() => app.texts().some((text) => /^Thread b line (?:[0-4]?\d)$/.test(text)));
  await expect(app.shows("text:Thread b line 59")).toBe(false);
});
