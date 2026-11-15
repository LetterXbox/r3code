import { expect, open, test } from "nsh/test";

test("partial markdown from a streaming reply renders without throwing", async () => {
  const app = await open("./ChatMarkdownFixture.tsx", { width: 800, height: 900 });
  await expect(app.texts()).toContain("Partial bol");
  await app.press("label:Stream open fence");
  await expect(app.texts()).toContain("Intro");
  // The reference hides the language label when pierre-icons has a specific icon for it (bash
  // does): only the icon shows, with "Language: bash" as its accessible name, not visible text.
  await expect(app.shows("label:Language: bash")).toBe(true);
  await expect(app.texts()).toContain("npm run bu");
});

test("headings, lists, quotes, tables and fenced code all render, and the code header copies", async () => {
  const app = await open("./ChatMarkdownFixture.tsx", { width: 800, height: 900 });
  await app.press("label:Show full markdown");
  const texts = await app.texts();
  for (const expected of ["Heading one", "first", "nested item", "second", "one", "two", "quoted text", "Name", "alpha", "After code"]) {
    await expect(app.texts()).toContain(expected);
  }
  void texts;
  // rehypeHeadingIds: the heading carries its GitHub slug id, so a `#heading-one` link can scroll to it.
  await expect(app.shows("id:user-content-heading-one")).toBe(true);
  // "ts" fences a plain ```ts block with no file title: the reference shows only the TypeScript
  // icon there (no visible language text), with "Language: ts" as its accessible name.
  await expect(app.shows("label:Language: ts")).toBe(true);
  await app.press("label:Copy code");
  await expect(app.clipboard()).toBe("const ready = true;");
});

test("fenced code is syntax highlighted: keywords and strings differ in colour from plain text", async () => {
  const app = await open("./ChatMarkdownFixture.tsx", { width: 800, height: 900 });
  await app.press("label:Show highlighted code");
  const keyword = (await app.spanStyle("text:const")).color;
  const string = (await app.spanStyle('text:"hi"')).color;
  const plain = (await app.spanStyle("text:value")).color;
  await expect(keyword === plain).toBe(false);
  await expect(string === plain).toBe(false);
  await expect(keyword === string).toBe(false);
});

test("the wrap toggle and the table copy menu are present", async () => {
  const app = await open("./ChatMarkdownFixture.tsx", { width: 800, height: 900 });
  await app.press("label:Show full markdown");
  await expect(app.shows("label:Wrap lines") || app.shows("label:Disable line wrap")).toBe(true);
  await expect(app.shows("label:Copy table")).toBe(true);
  await app.press("label:Copy table");
  await app.press("label:Copy as CSV");
  await expect(app.clipboard()).toBe("Name,Value\nalpha,1");
});

test("an open find highlights its query in the rendered text", async () => {
  const app = await open("./ChatMarkdownFixture.tsx", { width: 800, height: 900 });
  await app.press("label:Show full markdown");
  const before = (await app.spanStyle("text:quoted text")).backgroundColor ?? null;
  await app.press("label:Find quoted");
  const marked = (await app.spanStyle("text:quoted")).backgroundColor ?? null;
  await expect(marked !== null && marked !== before).toBe(true);
  await app.press("label:Stop find");
  await expect((await app.spanStyle("text:quoted text")).backgroundColor ?? null).toBe(before);
});

test("a shell block offers Run in terminal, a TypeScript block and a continued command do not", async () => {
  const app = await open("./ChatMarkdownFixture.tsx", { width: 800, height: 900 });
  await app.press("label:Show code blocks");
  await expect(app.texts()).toContain("run.sh");
  await expect(app.texts()).toContain("export const total: number = items.length // count");
  expect(app.count("label:Run in terminal")).toBe(1);
  expect(app.count("label:Copy code")).toBe(3);
  await app.press("label:Run in terminal");
  await expect(app.texts()).toContain("ran: npm test");
});

test("a streaming shell block cannot be run yet", async () => {
  const app = await open("./ChatMarkdownFixture.tsx", { width: 800, height: 900 });
  await app.press("label:Stream open fence");
  expect(app.count("label:Run in terminal")).toBe(0);
});

test("a mermaid fence draws as a diagram with a code toggle; one that cannot be drawn keeps its source and says why", async () => {
  const app = await open("./ChatMarkdownFixture.tsx", { width: 800, height: 900 });
  await app.press("label:Show mermaid");
  expect(app.shows("label:Mermaid diagram")).toBe(true);
  expect(app.count("label:Show code")).toBe(1);
  await expect(app.texts()).toContain("not a diagram");
  // MermaidDiagram.tsx: the failure reads "Unable to render diagram: <message>".
  await expect(app.texts()).toContain("Unable to render diagram: This is not a diagram type the renderer supports.");
  await app.press("label:Show code");
  await expect(app.texts()).toContain("flowchart LR");
  await app.press("label:Show diagram");
  expect(app.shows("label:Mermaid diagram")).toBe(true);
});

test("formulas typeset to images, and TeX that cannot be read keeps its source", async () => {
  const app = await open("./ChatMarkdownFixture.tsx", { width: 800, height: 900 });
  await app.press("label:Show math");
  await app.waitUntil(() => app.texts().includes("After math"));
  // A typeset formula is an inline object in the text (U+FFFC); the unreadable one shows its source instead.
  await expect(app.texts()).toContain("Euler: \uFFFC inline and a bad \uFFFC one.");
  await expect(app.texts()).toContain("\uFFFC");
  await expect(app.texts().some((text) => text.includes("\\(\\frac{\\)"))).toBe(true);
  await expect(app.texts()).toContain("After math");
});

test("math is off by default, as the reference's setting is: a formula stays as written", async () => {
  const app = await open("./ChatMarkdownFixture.tsx", { width: 800, height: 900 });
  await app.press("label:Show math as written");
  await app.waitUntil(() => app.texts().includes("After math"));
  await expect(app.texts()).toContain("Euler: $e^{i\\pi}+1=0$ inline and a bad $\\frac{$ one.");
  await expect(app.texts().some((text) => text.includes("\uFFFC"))).toBe(false);
});

test("a find match inside a mermaid diagram's source shows the source (markdownFindContext reveal)", async () => {
  const app = await open("./ChatMarkdownFixture.tsx", { width: 800, height: 900 });
  await app.press("label:Show mermaid");
  expect(app.shows("label:Mermaid diagram")).toBe(true);
  await app.press("label:Find in diagram");
  await expect(app.texts().some((text) => text.includes("A[Start]"))).toBe(true);
});
