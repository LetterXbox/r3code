import { expect, open, test } from "nsh/test";

test("the reply action supplies the assistant turn item", async () => {
  const app = await open("./MessageFixture.tsx", { width: 800, height: 600 });
  await app.press("label:Reply to this response");
  await app.waitFor("text:Reply item item-1");
  await app.press("label:Replace message");
  expect(app.shows("label:Reply to this response")).toBe(false);
});

test("renders markdown and copies the message shown after a row is reused", async () => {
  const app = await open("./MessageFixture.tsx", { width: 800, height: 600 });
  await expect(app.texts()).toContain("Result");
  await app.press("label:Copy assistant message");
  await expect(app.clipboard()).toBe("# Result\n\nUse **the cache**.\n\n```ts\nconst ready = true;\n```");
  await app.press("label:Fork from this response");
  await expect(app.texts()).toContain("Fork response m1");
  await app.press("label:Replace message");
  await expect(app.texts()).toContain("Second prompt");
  await expect(app.texts()).toContain("report.pdf");
  await expect(app.shows("label:Edit from here")).toBe(true);
  await expect(app.texts()).toContain("PDF · 123 B");
  await app.press("label:Preview report.pdf");
  await expect(app.texts()).toContain("Preview attachment f1");
  await app.press("label:Copy user message");
  await expect(app.clipboard()).toBe("Second prompt");
});

test("Edit from here asks to rewind to that message", async () => {
  const app = await open("./MessageFixture.tsx", { width: 800, height: 600 });
  await app.press("label:Replace message");
  await app.press("label:Edit from here");
  await expect(app.texts()).toContain("Rewind to m2");
});

test("a message that cannot be rewound shows no Edit from here", async () => {
  const app = await open("./MessageFixture.tsx", { width: 800, height: 600 });
  await expect(app.shows("label:Edit from here")).toBe(false);
});

test("a user message's context link renders as a coloured chip, not a raw link", async () => {
  const app = await open("./MessageFixture.tsx", { width: 800, height: 600 });
  await app.press("label:Show context message");
  await expect(app.texts()).toContain("@a.ts");
  await expect(app.texts()).not.toContain("t3-context");
  const chip = (await app.spanStyle("text:@a.ts")).color;
  const plain = (await app.spanStyle("text:Look at")).color;
  await expect(chip === plain).toBe(false);
});

test("an image context reference shows its size and opens the attachment", async () => {
  const app = await open("./MessageFixture.tsx", { width: 800, height: 600 });
  await app.press("label:Show image context");
  await app.waitFor("label:Open image image.png");
  expect(app.texts()).toContain("image.png 2 KB");
  await app.press("label:Open image image.png");
  expect(app.texts()).toContain("Preview attachment img1");
});

test("a file referenced in message text appears once as an actionable chip", async () => {
  const app = await open("./MessageFixture.tsx", { width: 800, height: 600 });
  await app.press("label:Show file context");
  await app.waitFor("label:Open file report.pdf");
  expect(app.texts()).toContain("report.pdf 2 KB");
  expect(app.shows("label:Preview report.pdf")).toBe(false);
  await app.press("label:Open file report.pdf");
  expect(app.texts()).toContain("Preview attachment file1");
});

test("a file-only message shows a card instead of an empty bubble or duplicate chip", async () => {
  const app = await open("./MessageFixture.tsx", { width: 800, height: 600 });
  await app.press("label:Show file only");
  await app.waitFor("label:Preview report.pdf");
  expect(app.shows("label:Open file report.pdf")).toBe(false);
});

test("an assistant item that is not completed wears its status as a chip; a completed one wears none", async () => {
  const app = await open("./MessageFixture.tsx", { width: 800, height: 600 });
  await app.press("label:Show failed message");
  await app.waitUntil(() => app.shows("label:Message status"));
  await expect(app.texts()).toContain("failed");
  await app.press("label:Show completed message");
  await app.waitUntil(() => app.texts().includes("Done answer"));
  await expect(app.shows("label:Message status")).toBe(false);
});

test("a user message offers a prompt link that opens its text as a new thread, and an assistant message does not", async () => {
  const app = await open("./MessageFixture.tsx", { width: 800, height: 600 });
  await expect(app.shows("label:Copy prompt link")).toBe(false);
  await app.press("label:Replace message");
  await app.press("label:Copy prompt link");
  await expect(app.clipboard()).toBe("https://app.t3.codes/new?prompt=Second+prompt");
});

test("copying a message shows the anchored Copied! toast", async () => {
  const app = await open("./MessageFixture.tsx", { width: 800, height: 600 });
  await app.press("label:Copy assistant message");
  await app.waitFor("text:Copied!");
  await expect(app.texts()).toContain("Copied!");
});

test("a mention chip carries its file icon and previews the file it names", async () => {
  const app = await open("./MessageFixture.tsx", { width: 800, height: 600 });
  await app.press("label:Show context message");
  await expect(app.shows("label:Preview /w/src/a.ts")).toBe(true);
});
