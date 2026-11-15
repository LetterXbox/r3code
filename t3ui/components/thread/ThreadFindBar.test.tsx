import { expect, open, test } from "nsh/test";

test("the find bar opens, counts matches, steps next and previous with wraparound, and closes", async () => {
  const app = await open("./ThreadFindFixture.tsx", { width: 800, height: 600 });
  await expect(app.shows("label:Find in thread")).toBe(false);
  await app.press("label:Open find");
  await expect(app.shows("label:Previous match")).toBe(true);
  await expect(app.enabled("label:Next match")).toBe(false);
  await app.type("label:Find in thread", "alpha");
  await expect(app.texts()).toContain("1/3");
  await app.press("label:Next match");
  await expect(app.texts()).toContain("2/3");
  await app.press("label:Next match");
  await app.waitFor("text:active:c");
  await app.press("label:Next match");
  await expect(app.texts()).toContain("1/3");
  await app.press("label:Previous match");
  await expect(app.texts()).toContain("3/3");
  await app.type("label:Find in thread", "zzz");
  await expect(app.texts()).toContain("0/0");
  await expect(app.enabled("label:Next match")).toBe(false);
  await app.press("label:Close find");
  await expect(app.shows("label:Previous match")).toBe(false);
});

test("Enter steps to the next match and Shift+Enter to the previous", async () => {
  const app = await open("./ThreadFindFixture.tsx", { width: 800, height: 600 });
  await app.press("label:Open find");
  await app.type("label:Find in thread", "alpha");
  await expect(app.texts()).toContain("1/3");
  await app.keyboard.press("enter");
  await expect(app.texts()).toContain("2/3");
  await app.keyboard.press("shift+enter");
  await expect(app.texts()).toContain("1/3");
  await app.keyboard.press("shift+enter");
  await expect(app.texts()).toContain("3/3");
});
