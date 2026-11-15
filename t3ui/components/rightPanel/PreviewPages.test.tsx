import { expect, open, test } from "nsh/test";

test("fm13: unreachable shows ERR_<code>; a download shows the file-not-shown page with Open in browser", async () => {
  const app = await open("./PreviewPagesFixture.tsx", { width: 1400, height: 700, platform: "macos" });
  await app.waitFor("text:ERR_102");
  expect(app.shows("text:This file can’t be shown here")).toBe(true);
  expect(app.texts().some((t) => t.includes("from localhost:3000 was downloaded instead."))).toBe(true);
  await app.press("label:Open in browser");
  await app.waitFor("text:opened 1");
});
