import { expect, open, test } from "nsh/test";

test("an existing conversation row updates its comment after a refresh", async () => {
  const app = await open("./ConversationRowRefreshFixture.tsx", { width: 600, height: 500 });
  await app.waitFor("text:Before refresh");
  await app.press("label:Refresh conversation");
  await app.waitFor("text:After refresh");
  expect(app.texts()).not.toContain("Before refresh");
});

test("a review finding can be handed to an agent", async () => {
  const app = await open("./ConversationRowRefreshFixture.tsx", { width: 600, height: 500 });
  await app.press("label:Fix in a thread");
  await app.waitFor("text:comment:comment");
});
