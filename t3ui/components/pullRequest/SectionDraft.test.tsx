import { expect, open, test } from "nsh/test";

test("collapsing the description preserves an unsaved editor draft", async () => {
  const app = await open("./SectionDraftFixture.tsx", { width: 600, height: 500 });
  await app.type("label:Description draft", "Unfinished edit");
  await app.press("label:Description section");
  await app.press("label:Description section");
  expect(app.value("label:Description draft")).toBe("Unfinished edit");
});
