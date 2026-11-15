import { expect, open, test } from "nsh/test";

test("recreated conversation rows still show updated message content", async () => {
  const app = await open("./TimelineStabilityFixture.tsx", { width: 900, height: 600 });
  await app.press("label:Refresh conversation");
  await app.waitFor("text:Message number 59, update 1");
  await expect(app.shows("text:Message number 59, update 1")).toBe(true);
});


test("streaming before the turn item arrives keeps the preceding response at the live end", async () => {
  const app = await open("./TimelineStabilityFixture.tsx", { width: 900, height: 800 });
  await app.press("label:Refresh conversation");
  await app.waitFor("text:Message number 59, update 1");
  await app.press("label:Stream message record");
  await app.waitFor("text:New streamed response");
  await expect(app.shows("text:Message number 59, update 1")).toBe(true);
  await expect(app.shows("text:New streamed response")).toBe(true);
});
