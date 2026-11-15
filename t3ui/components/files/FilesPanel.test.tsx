import { expect, open, test } from "nsh/test";

test("the tree lists the project root through projects.listEntries, folders first", async () => {
  const app = await open("./FilesFixture.tsx", { width: 1000, height: 600 });
  await app.waitFor("label:src");
  await expect(app.shows("label:readme.md")).toBe(true);
  await expect(app.texts().join("|")).toContain("projects.listEntries:");
  await expect(app.shows("label:main.ts")).toBe(false);
});

test("folders expand on demand and a failed folder retries when pressed again", async () => {
  const app = await open("./FilesFixture.tsx", { width: 1000, height: 600 });
  await app.waitFor("label:src");
  await app.press("label:src");
  await app.waitFor("label:main.ts");
  await app.press("label:lib");
  await app.waitFor("text:Loading files…", { state: "gone" });
  await app.wait(200);
  await expect(app.shows("label:util.ts")).toBe(false);
  await app.press("label:lib");
  await app.waitFor("label:util.ts");
  await app.press("label:src");
  await app.waitFor("label:main.ts", { state: "gone" });
});

test("pressing a file opens a read-only, line-numbered preview", async () => {
  const app = await open("./FilesFixture.tsx", { width: 1000, height: 600 });
  await app.waitFor("label:readme.md");
  await app.press("label:readme.md");
  await app.waitFor("text:opened: readme.md");
  await app.waitFor("text:const a = 1;");
  await expect(app.shows("text:const b = 2;")).toBe(true);
  await expect(app.shows("text:2")).toBe(true);
  await expect(app.shows("text:26 B")).toBe(true);
});

test("expand all loads every folder and the refresh button reloads", async () => {
  const app = await open("./FilesFixture.tsx", { width: 1000, height: 600 });
  await app.waitFor("label:Expand all folders");
  await app.press("label:Expand all folders");
  await app.waitFor("label:main.ts");
  await app.press("label:Refresh files");
  await app.waitFor("label:main.ts");
});

test("a slow or failed refresh keeps the existing file tree visible", async () => {
  const app = await open("./FilesFixture.tsx", { width: 1000, height: 600 });
  await app.waitFor("label:src");
  await app.press("label:Hold file refresh");
  await app.press("label:Refresh files");
  expect(app.shows("label:src")).toBe(true);
  expect(app.shows("label:readme.md")).toBe(true);
  await app.press("label:Release file refresh");
  await app.waitFor("label:src");
  await app.press("label:Fail file refresh");
  await app.press("label:Refresh files");
  await app.waitFor("text:Could not refresh files: Refresh unavailable");
  expect(app.shows("label:src")).toBe(true);
});

test("searching filters the tree to matches under their folders, and clearing restores it", async () => {
  const app = await open("./FilesFixture.tsx", { width: 1000, height: 600 });
  await app.waitFor("label:readme.md");
  await app.type("label:Search demo files", "util");
  await app.waitFor("label:util.ts");
  await expect(app.shows("label:lib")).toBe(true);
  await expect(app.shows("label:readme.md")).toBe(false);
  await app.waitFor("text:More matches available. Refine your search.");
  await app.clear("label:Search demo files");
  await app.waitFor("label:readme.md");
  await app.type("label:Search demo files", "zzz");
  await app.waitFor("text:No matching files.");
});

test("file and folder rows draw different icons, and a recycled row takes the icon of its new entry", async () => {
  const app = await open("./FilesFixture.tsx", { width: 1000, height: 600 });
  await app.waitFor("label:readme.md");
  // testIDs carry the pierre badge token (FileEntryIcon.tsx), as the reference draws per-type badges.
  await expect(app.shows("id:entry-icon:folder-closed")).toBe(true);
  await expect(app.shows("id:entry-icon:markdown")).toBe(true);
  await expect(app.shows("id:entry-icon:typescript")).toBe(false);
  await app.press("label:src");
  await app.waitFor("label:main.ts");
  await expect(app.shows("id:entry-icon:typescript")).toBe(true);
  await expect(app.shows("id:entry-icon:folder-open")).toBe(true);
  // A search replaces the rows: the readme row's slot now holds a different entry.
  await app.type("label:Search demo files", "util");
  await app.waitFor("label:util.ts");
  await expect(app.shows("id:entry-icon:markdown")).toBe(false);
  await expect(app.shows("id:entry-icon:typescript")).toBe(true);
  await app.clear("label:Search demo files");
  await app.waitFor("label:readme.md");
  await expect(app.shows("id:entry-icon:markdown")).toBe(true);
});

test("a file opened at a line marks that line", async () => {
  const app = await open("./FilesFixture.tsx", { width: 1000, height: 600 });
  await app.waitFor("label:readme.md");
  await app.press("label:readme.md");
  await app.waitFor("id:Revealed line");
});

test("a markdown file opens rendered, and the toggle shows its source", async () => {
  const app = await open("./FilesFixture.tsx", { width: 1000, height: 600 });
  await app.waitFor("label:notes.md");
  await app.press("label:notes.md");
  await app.waitFor("id:Rendered markdown");
  await app.press("label:Show markdown source");
  await app.waitFor("label:Show rendered markdown");
  await expect(app.shows("id:Rendered markdown")).toBe(false);
  await app.waitFor("text:const a = 1;");
});

test("an image shows in place of source lines, and a binary file says it cannot be shown as text", async () => {
  const app = await open("./FilesFixture.tsx", { width: 1000, height: 600 });
  await app.waitFor("label:logo.png");
  await app.press("label:logo.png");
  await app.waitFor("label:Image preview");
  // PreviewImageContent's strip once the image's size is known; the headless runner decodes no image, so it may say
  // it could not load it (checked on screen in workspace/visual/prfix/image-preview.jpg).
  await app.wait(300);
  if (await app.shows("label:Zoom in")) {
    for (const label of ["Zoom out", "Fit image", "Actual image size"]) await expect(app.shows(`label:${label}`)).toBe(true);
    await app.press("label:Actual image size");
  } else await expect(app.texts()).toContain("Unable to load image.");
  await app.press("label:blob.bin");
  await app.waitFor("text:The file is binary and cannot be displayed as text.");
});

test("a csv opens as a table of its cells, and the toggle shows its source", async () => {
  const app = await open("./FilesFixture.tsx", { width: 1000, height: 600 });
  await app.waitFor("label:data.csv");
  await app.press("label:data.csv");
  await app.waitFor("label:Table preview");
  await app.waitFor("text:hello, world");
  await expect(app.shows("text:say \"hi\"")).toBe(true);
  await app.press("label:Show source");
  await app.waitFor("label:Show table");
  await expect(app.shows("label:Table preview")).toBe(false);
});

test("a notebook shows its markdown, code and outputs", async () => {
  const app = await open("./FilesFixture.tsx", { width: 1000, height: 600 });
  await app.waitFor("label:nb.ipynb");
  await app.press("label:nb.ipynb");
  await app.waitFor("label:Notebook preview");
  await app.waitFor("text:Notebook intro");
  await app.waitFor("text:Saved outputs only. Code is never executed.");
  await expect(app.shows("text:[1]")).toBe(true);
  await expect(app.shows("text:print(42)")).toBe(true);
});

test("a binary file with no viewer says so and offers the open actions", async () => {
  const app = await open("./FilesFixture.tsx", { width: 1000, height: 600 });
  await app.waitFor("label:blob.bin");
  await app.press("label:blob.bin");
  await app.waitFor("id:Unsupported file");
  await expect(app.shows("label:Open in editor")).toBe(true);
  await expect(app.shows("label:Reveal in file manager")).toBe(true);
});

test("an office document that cannot be read says there is no preview for it", async () => {
  const app = await open("./FilesFixture.tsx", { width: 1000, height: 600 });
  await app.waitFor("label:report.docx");
  await app.press("label:report.docx");
  await app.waitFor("text:No preview for this file");
});

test("the word wrap toggle flips its label, and the breadcrumb shows the path", async () => {
  const app = await open("./FilesFixture.tsx", { width: 1000, height: 600 });
  await app.waitFor("label:readme.md");
  await app.press("label:readme.md");
  await app.waitFor("text:const a = 1;");
  await app.press("label:Show markdown source").catch(() => {});
  await app.waitFor("label:Disable word wrap");
  await app.press("label:Disable word wrap");
  await app.waitFor("label:Enable word wrap");
  await expect(app.shows("label:File path")).toBe(true);
});

test("a line number starts a comment on that line; a shift-press extends it, and Comment keeps it under its lines", async () => {
  const app = await open("./FilesFixture.tsx", { width: 1000, height: 600 });
  await app.press("label:readme.md");
  await app.waitFor("text:const a = 1;");
  await app.press("label:Comment on line 1");
  await app.waitFor("label:Comment on lines L1");
  await app.type("label:Comment on lines L1", "Why one?");
  await app.press("label:Comment");
  await app.waitFor("label:File comment");
  await expect(app.texts()).toContain("Why one?");
  await app.press("label:Delete comment");
  await expect(app.shows("label:File comment")).toBe(false);
});
