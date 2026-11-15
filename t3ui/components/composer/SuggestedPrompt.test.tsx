import { expect, open, test } from "nsh/test";

test("the Tab hint disappears when the suggestion becomes editable draft text", async () => {
  const app = await open("./SuggestedPromptFixture.tsx", { width: 700, height: 400 });
  await app.waitFor("text:⇥ Tab");
  await app.keyboard.press("tab");
  await app.waitFor("text:draft:Continue with the remaining checks");
  expect(app.shows("text:⇥ Tab")).toBe(false);
  await app.keyboard.press("x");
  await app.waitUntil(() => app.value("id:composer-prompt")?.includes("x") === true);
});

test("a suggestion arriving after the editor mounts shows its Tab hint", async () => {
  const app = await open("./SuggestedPromptFixture.tsx", { width: 700, height: 400 });
  await app.waitFor("text:⇥ Tab");
  await app.press("label:Toggle suggestion");
  await app.waitUntil(() => !app.shows("text:⇥ Tab"));
  await app.press("label:Toggle suggestion");
  await app.waitFor("text:⇥ Tab");
});
