import { expect, open, test } from "nsh/test";

const options = { width: 900, height: 600 };

test("writable text opens in an editor whose edits are written through projects.writeFile", async () => {
  const app = await open("./FileViewersFixture.tsx", options);
  await app.waitFor("label:Edit a.ts");
  await app.clear("label:Edit a.ts");
  await app.type("label:Edit a.ts", "const a = 2;");
  await app.waitFor("text:writes: a.ts=const a = 2;", { timeout: 4000 });
});

test("without write access the source is read-only and says edits wait for write access", async () => {
  const app = await open("./FileViewersFixture.tsx", options);
  await app.waitFor("label:Edit a.ts");
  await app.press("label:toggle write");
  await app.waitFor("text:Read-only connection. Unsaved edits are kept until write access returns.");
  await app.waitFor("text:const a = 1;");
  await expect(app.shows("label:Edit a.ts")).toBe(false);
});

test("a file the read cut short opens in full with a summary of its lines", async () => {
  const app = await open("./FileViewersFixture.tsx", options);
  await app.press("label:open big.txt");
  await app.waitFor("text:Full file");
  await app.waitFor("label:Large file summary");
  await app.waitFor("text:third");
  await expect(app.shows("text:This file is too large to show in full.")).toBe(false);
});

test("an archive lists its entries and a folder opens", async () => {
  const app = await open("./FileViewersFixture.tsx", options);
  await app.press("label:open x.zip");
  await app.waitFor("label:Archive");
  await app.waitFor("label:a.txt");
  await app.press("label:d");
  await app.waitFor("label:b.md");
});

test("a database shows its first table and pages through rows", async () => {
  const app = await open("./FileViewersFixture.tsx", options);
  await app.press("label:open x.db");
  await app.waitFor("label:Database");
  await app.waitFor("text:a \"b\" (2 rows)");
  await expect(app.shows("label:Previous rows")).toBe(true);
});

// The reference draws docx / xlsx / pptx with its own viewers (OpenXmlOfficeViewer over @betteroffice/*); the port now
// loads that same page in a web view (DocumentViewer), which the headless runner does not run, so this checks the
// surface each kind opens rather than the cells the old native text reader printed.
test("a docx and an xlsx open the reference's Open XML viewer page", async () => {
  const app = await open("./FileViewersFixture.tsx", options);
  await app.press("label:open x.docx");
  await app.waitFor("label:Word document preview");
  await app.press("label:open x.xlsx");
  await app.waitFor("label:Spreadsheet preview");
});

test("a Mermaid file draws its diagram and the toggle shows the source", async () => {
  const app = await open("./FileViewersFixture.tsx", options);
  await app.press("label:open flow.mmd");
  await app.waitFor("id:Mermaid diagram");
  await app.press("label:Show Mermaid source");
  await app.waitFor("label:Show rendered diagram");
});

test("the file tab shows a resizable explorer that its toggle hides and shows", async () => {
  const app = await open("./FileViewersFixture.tsx", options);
  await app.waitFor("label:File explorer");
  await expect(app.shows("label:Resize file explorer")).toBe(true);
  await app.press("label:Hide file explorer");
  await app.waitFor("label:File explorer", { state: "gone" });
  await app.press("label:Show file explorer");
  await app.waitFor("label:File explorer");
});

test("a host folder opens as a folder view with host breadcrumbs and no project crumb or side explorer", async () => {
  const app = await open("./FileViewersFixture.tsx", options);
  await app.press("label:open /Users/x/.t3");
  await app.waitFor("label:Folder");
  await app.waitFor("text:.t3");
  await expect(app.shows("text:Users")).toBe(true);
  await expect(app.shows("text:demo")).toBe(false);
  await expect(app.shows("label:File explorer")).toBe(false);
});
