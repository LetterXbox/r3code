import { expect, open, test } from "nsh/test";

test("ThreadView keeps the bounded snapshot and its minimap strips until Load earlier turns is requested", async () => {
  const app = await open("./ThreadHistoryParityFixture.tsx", { width: 1200, height: 800 });
  await app.wait(100);
  expect(app.texts()).toContain("history-fetches:0");
  expect(app.shows("label:Load earlier turns")).toBe(true);
  expect(app.shows("id:minimap-strip-message:m-u1")).toBe(true);
  expect(app.shows("id:minimap-strip-message:m-u2")).toBe(true);
  expect(app.shows("id:minimap-strip-message:m-u-earlier")).toBe(false);

  await app.press("label:Load earlier turns");
  await app.waitUntil(() => app.shows("id:minimap-strip-message:m-u-earlier"));
  expect(app.texts()).toContain("history-fetches:1");
  expect(app.texts()).toContain("Earlier prompt");
});
