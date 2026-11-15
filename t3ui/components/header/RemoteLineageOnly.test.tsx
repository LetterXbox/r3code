import { expect, open, test } from "nsh/test";

test("completed remote-only agents appear in Previous agents with the correct count", async () => {
  const app = await open("./RemoteLineageOnlyFixture.tsx", { width: 900, height: 1100, platform: "macos" });
  await app.waitFor("label:Previous agents");
  expect(app.texts()).toContain("2");
  await app.press("label:Previous agents");
  await app.waitFor("label:First remote");
  expect(app.shows("label:Second remote")).toBe(true);
});
