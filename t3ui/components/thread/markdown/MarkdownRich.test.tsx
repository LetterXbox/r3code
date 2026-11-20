import { expect, open, test } from "nsh/test";

test("a sent reply shows the response opening and its subagent attribution", async () => {
  const app = await open("./MarkdownRichFixture.tsx", { width: 1100, height: 650 });
  await app.press("label:Show response");
  await app.press("label:Reply to response: Earlier response. Show details");
  await app.waitFor("text:Review helper");
  expect(app.shows("label:Go to source")).toBe(true);
});

const OPEN = { width: 800, height: 900 };

test("file links, inline paths, threads, skills, web links, citations and Codex directives become chips", async () => {
  const app = await open("./MarkdownRichFixture.tsx", OPEN);
  await app.waitUntil(() => app.texts().includes("a.ts · L12") || app.shows("label:File a.ts · L12"));
  expect(app.shows("label:File a.ts · L12")).toBe(true);
  expect(app.shows("label:File b.ts · L3")).toBe(true);
  expect(app.shows("label:File c.ts")).toBe(true);
  // A link whose text is not the file keeps its text in front of the chip.
  await expect(app.texts().some((text) => text.includes("notes"))).toBe(true);
  // MarkdownThreadLink: a thread the shell lacks is a chip until the lookup settles missing.
  expect(app.shows("label:Thread no longer available") || app.shows("label:thread") || app.shows("label:Thread thread")).toBe(true);
  expect(app.shows("label:docs")).toBe(true);
  expect(app.shows("label:Skill Code Review. Show details")).toBe(true);
  expect(app.shows("label:Quoted assistant text: check this. Show details")).toBe(true);
  // The Codex follow-up is its label and the file citation a file chip.
  await expect(app.texts().some((text) => text.includes("Prepare print version"))).toBe(true);
  expect(app.shows("label:File d.ts · L4")).toBe(true);
});

test("a skill chip opens a popover with its description and View instructions", async () => {
  const app = await open("./MarkdownRichFixture.tsx", OPEN);
  await app.press("label:Skill Code Review. Show details");
  await expect(app.texts()).toContain("Reviews a diff.");
  expect(app.shows("label:View instructions")).toBe(true);
});

test("a citation chip shows the quote and the comment with Go to source", async () => {
  const app = await open("./MarkdownRichFixture.tsx", OPEN);
  await app.press("label:Quoted assistant text: check this. Show details");
  await expect(app.texts()).toContain("the quoted reply text");
  expect(app.shows("label:Go to source")).toBe(true);
});

test("a short web link chip takes its press through the link interceptor", async () => {
  const app = await open("./MarkdownRichFixture.tsx", OPEN);
  await app.press("label:docs");
  await expect(app.texts()).toContain("opened: https://example.com/docs");
});

test("alerts show their title, a disclosure opens on a press, and a template card offers Use template", async () => {
  const app = await open("./MarkdownRichFixture.tsx", OPEN);
  await app.press("label:Show blocks");
  await expect(app.texts()).toContain("Note");
  await expect(app.texts()).toContain("Warning");
  await expect(app.texts()).toContain("Heads up");
  await expect(app.texts()).toContain("More");
  expect(app.texts().includes("Hidden body")).toBe(false);
  await app.press("label:Expand details");
  await expect(app.texts()).toContain("Hidden body");
  await expect(app.texts()).toContain("Hello World");
  await expect(app.texts()).toContain("Document template");
  await app.press("label:Use template");
  await expect(app.texts().some((text) => text.startsWith("draft: Create a document using this $artifact-template-hello about"))).toBe(true);
  await app.press("label:Use template");
  await expect(app.texts().filter((text) => text.startsWith("draft: ")).length).toBe(1);
});

test("task items toggle by writing the marker back into the source", async () => {
  const app = await open("./MarkdownRichFixture.tsx", OPEN);
  await app.press("label:Show tasks");
  expect(app.count("label:Toggle task")).toBe(2);
  await app.press("label:Toggle task >> nth=0");
  await app.waitUntil(() => app.texts().includes("source: - [x] first\n- [x] second"));
});

test("media that cannot load says so in the reference's words", async () => {
  const app = await open("./MarkdownRichFixture.tsx", OPEN);
  await app.press("label:Show media");
  await expect(app.texts()).toContain("Image unavailable · chart");
});
