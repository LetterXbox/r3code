// The pull request page's "Linked from N threads" opens the palette on its threads; Escape out of a child search brings the query and rows back.
import { expect, open, test } from "nsh/test";

const URL = "https://github.com/acme/widgets/pull/2288";

test("the palette opens on the pull request URL with its linked threads as rows", async () => {
  const app = await open("./PaletteLinkedFixture.tsx", { width: 1280, height: 800 });
  await app.press("label:Open linked");
  await app.waitUntil(() => app.texts().includes("Port the rail"), { timeout: 3000 });
  await expect(app.texts()).toContain("Old spike");
  await expect(app.texts()).toContain("Linked thread");
  await expect(app.texts()).toContain("Archived thread");
  await expect(app.texts()).toContain(`query=${URL}`);
});

test("Escape from a child search restores the query and the linked rows, a second Escape closes", async () => {
  const app = await open("./PaletteLinkedFixture.tsx", { width: 1280, height: 800 });
  await app.press("label:Open linked on file query");
  await app.waitUntil(() => app.texts().includes("Port the rail"), { timeout: 3000 });
  await app.press("label:Go to file");
  await app.waitUntil(() => !app.texts().includes("Port the rail"), { timeout: 3000 });
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.texts().includes("Port the rail"), { timeout: 3000 });
  await expect(app.texts()).toContain("query=Go to file");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.texts().includes("Navigate"), { timeout: 3000 });
});
