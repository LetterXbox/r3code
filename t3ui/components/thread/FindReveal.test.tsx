import { expect, open, test } from "nsh/test";

const options = { width: 900, height: 1400 } as const;

test("the active find match opens a collapsed user message and a closed details block; other rows stay folded", async () => {
  const app = await open("./FindRevealFixture.tsx", options);
  await app.waitFor("label:Expand details");
  expect(app.count("label:Show full message")).toBe(2);
  await app.press("label:Find needle in u1");
  // u1 holds the active match: it opens. u2 does not; the details block is another row's.
  await app.waitFor("label:Show less");
  expect(app.count("label:Show full message")).toBe(1);
  expect(app.shows("label:Expand details")).toBe(true);
  await app.press("label:Find needle in a1");
  await app.waitFor("label:Collapse details");
});

test("a match inside a fenced code block is highlighted there, as the active match when the text has none", async () => {
  const app = await open("./FindRevealFixture.tsx", options);
  await app.press("label:Find in code");
  await app.wait(200);
  const style = app.spanStyle("text:codeneedle") as unknown as Record<string, unknown>;
  expect(JSON.stringify(style)).toContain("e3a12f");
});
