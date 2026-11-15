import { expect, open, test } from "nsh/test";

test("an opened row draws the structured item: exit code, changes, search results, web links, tool args and todo glyphs", async () => {
  const app = await open("./InspectorFixture.tsx", { width: 900, height: 1400, clock: {} });
  await app.press("label:Expand Ran 1 command, changed 1 file, and performed 4 other actions");
  for (const id of ["Command", "File change", "File search", "Web search", "Tool", "Tasks"]) {
    if (await app.shows(`label:Expand ${id}`)) await app.press(`label:Expand ${id}`);
    // A failed call's row reads "<title>, tool call failed" (TimelineWorkEntryRow's accessible name).
    else if (await app.shows(`label:Expand ${id}, tool call failed`)) await app.press(`label:Expand ${id}, tool call failed`);
  }
  const texts = app.texts();
  await expect(texts).toContain("$ npm test");
  await expect(texts).toContain("exit 2");
  await expect(texts).toContain("1 failing");
  await expect(texts).toContain("rename src/old.ts → /work/space/src/a.ts (text, text/typescript)");
  await expect(texts).toContain("/work/space/src/b.ts:4:7");
  await expect(texts).toContain("// TODO: ship");
  await expect(texts).toContain("GPUI");
  await expect(texts).toContain("A fast UI framework");
  await expect(texts).toContain("query ");
  await expect(texts).toContain("✓ Read\n◉ Write\n○ Ship");
});

test("a file change's Open diff selects that tool call's diff (threadId, itemId, revision)", async () => {
  const app = await open("./InspectorFixture.tsx", { width: 900, height: 1400, clock: {} });
  await app.press("label:Expand Ran 1 command, changed 1 file, and performed 4 other actions");
  if (await app.shows("label:Expand File change")) await app.press("label:Expand File change");
  await app.press("label:Open diff");
  await expect(app.texts()).toContain('diff {"kind":"tool-call","threadId":"t1","itemId":"edit","revision":"2026-01-01T00:00:01Z"}');
});

test("expanding a tool with summarized input loads its complete input", async () => {
  const app = await open("./ItemDetailSummaryFixture.tsx", { width: 800, height: 600 });
  await app.press("label:Expand Inspect");
  await app.waitFor("text:The complete tool input is available");
});
