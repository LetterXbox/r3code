// The thread search's states (Sidebar.tsx): "Searching thread messages…" only while nothing has matched yet, then "No threads found".
import { expect, open, test } from "nsh/test";

const options = { width: 400, height: 400, platform: "macos" as const };

test("pending with no result says Searching thread messages…, then No threads found", async () => {
  const app = await open("./ThreadSearchStatesFixture.tsx", options);
  await app.waitFor("text:Searching thread messages…");
  await app.press("label:Finish");
  await app.waitFor("text:No threads found");
  await expect(app.texts()).not.toContain("Searching thread messages…");
});

test("a result shows its excerpt and no searching line", async () => {
  const app = await open("./ThreadSearchStatesFixture.tsx", options);
  await app.press("label:Result");
  await app.waitFor("label:Open search result Alpha one");
  await expect(app.texts()).toContain("You: Fixed the sidebar");
  await expect(app.texts()).not.toContain("Searching thread messages…");
});
