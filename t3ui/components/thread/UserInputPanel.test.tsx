import { expect, open, test } from "nsh/test";

test("questions advance one at a time and submit selected option values with custom text", async () => {
  const app = await open("./UserInputFixture.tsx", { width: 800, height: 600 });
  await expect(app.texts()).toContain("1/2");
  await expect(app.texts()).toContain("Which should be included?");
  await expect(app.enabled("label:Next question")).toBe(false);
  await expect(app.shows("label:Previous question")).toBe(false);
  await app.press("label:Tests");
  await app.press("label:Docs");
  await expect(app.enabled("label:Next question")).toBe(true);
  await app.press("label:Next question");
  await expect(app.texts()).toContain("2/2");
  await expect(app.texts()).toContain("Anything else?");
  await expect(app.enabled("label:Submit answers")).toBe(false);
  await app.type("label:Answer Note", "Run these first");
  await app.press("label:Toggle questions");
  await app.press("label:Toggle questions");
  await expect(app.value("label:Answer Note")).toBe("Run these first");
  await expect(app.enabled("label:Submit answers")).toBe(true);
  await app.press("label:Submit answers");
  await app.waitFor('text:{"choices":["test-value","Docs"],"note":"Run these first"}');
});

test("Previous returns to the earlier question with its selection kept", async () => {
  const app = await open("./UserInputFixture.tsx", { width: 800, height: 600 });
  await app.press("label:Tests");
  await app.press("label:Next question");
  await app.press("label:Previous question");
  await expect(app.texts()).toContain("Which should be included?");
  await expect(app.enabled("label:Next question")).toBe(true);
});

test("the banner collapses to the header and question, and expands again", async () => {
  const app = await open("./UserInputFixture.tsx", { width: 800, height: 600 });
  await expect(app.shows("label:Tests")).toBe(true);
  await app.press("label:Hide the question and its options");
  await expect(app.shows("label:Tests")).toBe(false);
  await expect(app.texts()).toContain("Which should be included?");
  await app.press("label:Show the question and its options");
  await expect(app.shows("label:Tests")).toBe(true);
});

test("choosing the only single-choice answer advances automatically and submits", async () => {
  const app = await open("./UserInputFixture.tsx", { width: 800, height: 600 });
  await app.press("label:Tests");
  await app.press("label:Next question");
  await app.type("label:Answer Note", "x");
  await app.press("label:Submit answers");
  await app.waitFor("label:Fast");
  await app.press("label:Fast");
  await app.waitFor('text:{"mode":"Fast"}');
});

test("digit keys pick the matching option while no input has focus", async () => {
  const app = await open("./UserInputFixture.tsx", { width: 800, height: 600 });
  await expect(app.enabled("label:Next question")).toBe(false);
  await app.keyboard.press("2");
  await expect(app.enabled("label:Next question")).toBe(true);
  await app.keyboard.press("2");
  await expect(app.enabled("label:Next question")).toBe(false);
  await app.keyboard.press("9");
  await expect(app.enabled("label:Next question")).toBe(false);
});

test("a dismissible question can be dismissed without answering; others cannot", async () => {
  const app = await open("./UserInputFixture.tsx", { width: 800, height: 600 });
  await expect(app.shows("label:Dismiss question without answering")).toBe(false);
  await app.press("label:Tests");
  await app.press("label:Docs");
  await app.press("label:Next question");
  await app.type("label:Answer Note", "x");
  await app.press("label:Submit answers");
  await app.waitFor("text:Which mode?");
  await expect(app.shows("label:Dismiss question without answering")).toBe(true);
  await app.press("label:Dismiss question without answering");
  await app.waitFor("text:dismissed:question-2");
  await expect(app.shows("label:Dismiss question without answering")).toBe(false);
});
