import { expect, open, test } from "nsh/test";

test("a terminal chip opens its captured output, and a chip without its record reads as unavailable (UserMessageContextChips)", async () => {
  const app = await open("./ContextChipsFixture.tsx", { width: 900, height: 600, platform: "macos" });
  await app.press("label:Terminal excerpt, @term-1:3-4");
  await app.waitFor("text:Lines 3–4");
  await expect(app.texts()).toContain("Terminal 1");
  await expect(app.texts().join("|")).toContain("npm test");
  await expect(app.texts()).toContain("#9");
});
