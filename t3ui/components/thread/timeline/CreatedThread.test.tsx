import { expect, open, test } from "nsh/test";

test("created-thread rows: the log row and the summary card both open the chat", async () => {
  const app = await open("./CreatedThreadFixture.tsx", { width: 800, height: 400 });
  await expect(app.texts()).toContain("Created thread · Fix the build");
  await expect(app.texts()).toContain("Created thread");
  await app.press("label:Open Fix the build");
  await expect(app.texts()).toContain("log");
  await app.press("label:Open created thread");
  await expect(app.texts()).toContain("card");
});

test("a superseded attempt fold reads Cut off by a steer and toggles", async () => {
  const app = await open("./CreatedThreadFixture.tsx", { width: 800, height: 400 });
  await expect(app.texts()).toContain("Cut off by a steer");
  await app.press("label:Superseded attempt");
  await expect(app.texts()).toContain("open");
});
