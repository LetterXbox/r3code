import { expect, open, test } from "nsh/test";

test("hunk separators count the hidden lines and reveal them from the file's texts", async () => {
  const app = await open("./DiffContextFixture.tsx", { width: 1100, height: 900 });
  await app.waitFor("label:File src/a.ts");
  await app.waitFor("label:2 unmodified lines");
  await app.waitFor("label:30 unmodified lines");
  // Below the last hunk the count needs the file: Pierre's copy until it is fetched.
  await app.waitFor("label:More unchanged context may be available");
  await expect(app.texts()).not.toContain("line 20");
  // A short gap has one button that reveals all of it.
  await app.press("label:30 unmodified lines >> label:Expand");
  await app.waitFor("text:line 20");
  await expect(app.shows("label:30 unmodified lines")).toBe(false);
  await app.waitFor("label:Content requests");
  await expect(app.texts()).toContain("branch-range change main feature src/a.ts src/a.ts");
  // Once fetched, the tail knows its size (300 - 42) and offers 100 lines at a time.
  await app.waitFor("label:258 unmodified lines");
  await app.press("label:Expand up");
  await app.waitFor("label:158 unmodified lines");
});
