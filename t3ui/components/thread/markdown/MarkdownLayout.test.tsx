import { expect, open, test } from "nsh/test";

test("a heading, a paragraph and a nested list all render, with a marker for every item", async () => {
  const app = await open("./MarkdownLayoutFixture.tsx", { width: 700, height: 600 });
  const texts = app.texts();
  for (const expected of ["Heading two", "Paragraph under the heading.", "first item", "nested item", "nested two", "second item", "one", "two", "ten", "Closing paragraph."]) {
    await expect(texts).toContain(expected);
  }
  // Ordered markers are text: numbers count from the list's start.
  await expect(texts).toContain("1.");
  await expect(texts).toContain("2.");
  await expect(texts).toContain("3.");
});

test("ordered lists past nine items keep the numbers", async () => {
  const app = await open("./MarkdownLayoutFixture.tsx", { width: 700, height: 600 });
  await app.press("label:Show long ordered list");
  await expect(app.texts()).toContain("10.");
  await expect(app.texts()).toContain("12.");
});

test("a fenced code card between paragraphs still renders its header", async () => {
  const app = await open("./MarkdownLayoutFixture.tsx", { width: 700, height: 600 });
  await app.press("label:Show code between text");
  // ts has its own file icon, so the header shows the icon alone (reference MarkdownCodeBlockTitleContent); its label names the language.
  await expect(app.shows("label:Language: ts")).toBe(true);
  await expect(app.shows("label:Copy code")).toBe(true);
});
