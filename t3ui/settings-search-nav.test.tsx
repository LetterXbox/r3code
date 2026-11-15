import { expect, open, test } from "nsh/test";

async function search(text: string) {
  const app = await open("./App.tsx", { width: 1280, height: 900 });
  await app.keyboard.press("mod+,");
  await app.wait(60);
  await app.type("label:Search settings", text);
  await app.wait(60);
  return app;
}

test("the first result is highlighted and the arrow keys move the highlight with wrap-around", async () => {
  const app = await search("notifications");
  await expect(app.shows("id:Settings result thread-notifications (active)")).toBe(true);
  await expect(app.shows("id:Settings result in-app-notifications (idle)")).toBe(true);
  await app.keyboard.press("down");
  await app.wait(30);
  await expect(app.shows("id:Settings result in-app-notifications (active)")).toBe(true);
  // With the shipped cloud config the reference also lists "Publish agent activity" (cloudOnly, its search terms
  // say "notifications"), so the list is three long before it wraps.
  await app.keyboard.press("down");
  await app.wait(30);
  await expect(app.shows("id:Settings result publish-agent-activity (active)")).toBe(true);
  await app.keyboard.press("down");
  await app.wait(30);
  await expect(app.shows("id:Settings result thread-notifications (active)")).toBe(true);
  await app.keyboard.press("up");
  await app.wait(30);
  await expect(app.shows("id:Settings result publish-agent-activity (active)")).toBe(true);
});

test("Enter opens the highlighted setting's panel, highlights its row and clears the search", async () => {
  const app = await search("Rich text composer");
  await app.keyboard.press("enter");
  await app.wait(150);
  await expect(app.shows("id:Settings row composer-rich-text (target)")).toBe(true);
  await expect(app.texts()).not.toContain("No settings found");
  await expect(app.value("label:Search settings")).toBe("");
});

test("Escape clears the query and restores the section list", async () => {
  const app = await search("Rich text composer");
  await app.keyboard.press("escape");
  await app.wait(60);
  await expect(app.value("label:Search settings")).toBe("");
  await expect(app.shows("label:Settings sections")).toBe(true);
});

test("the search results are a listbox named Settings search results", async () => {
  const app = await search("theme");
  await expect(app.shows("label:Settings search results")).toBe(true);
});
