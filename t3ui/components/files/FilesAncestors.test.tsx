import { expect, open, test } from "nsh/test";

test("a selected deep file has its folders read and opened (loadFileAncestors, fm13)", async () => {
  const app = await open("./FilesAncestorsFixture.tsx", { width: 400, height: 500 });
  await app.waitFor("label:util.ts");
  await expect(app.shows("label:main.ts")).toBe(true);
});
