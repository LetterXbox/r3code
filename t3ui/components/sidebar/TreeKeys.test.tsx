import { expect, open, test } from "nsh/test";

const options = { width: 400, height: 500, platform: "macos" as const };

// Focus a row without opening it: a keyboard user tabs to it.
async function focused(_row: string) {
  const app = await open("./TreeFixture.tsx", options);
  await app.keyboard.press("tab");
  return app;
}

test("tree keys do nothing until a row has the keyboard focus", async () => {
  const app = await open("./TreeFixture.tsx", options);
  await app.keyboard.press("down");
  await expect(app.texts()).toContain("Clicked: none");
});

test("Tab reaches the first row and Down walks the rows without opening them", async () => {
  const app = await focused("Leaf thread");
  await app.keyboard.press("down");
  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  await expect(app.texts()).toContain("Clicked: a1");
});

test("Left on a child goes to its folder and Left again closes it", async () => {
  const app = await focused("Leaf thread");
  await app.keyboard.press("down");
  await app.keyboard.press("down");
  await app.keyboard.press("left");
  await app.keyboard.press("left");
  await expect(app.shows("label:Child one, Demo")).toBe(false);
  await expect(app.texts()).not.toContain("Child one");
});

test("Right opens a closed folder and then enters it", async () => {
  const app = await focused("Leaf thread");
  await app.keyboard.press("down");
  await app.keyboard.press("left");
  await expect(app.texts()).not.toContain("Child one");
  await app.keyboard.press("right");
  await expect(app.texts()).toContain("Child one");
  await app.keyboard.press("right");
  await app.keyboard.press("enter");
  await expect(app.texts()).toContain("Clicked: a1");
});

test("End jumps to the last row and Home back to the first", async () => {
  const app = await focused("Leaf thread");
  await app.keyboard.press("end");
  await app.keyboard.press("home");
  await app.keyboard.press("enter");
  await expect(app.texts()).toContain("Clicked: leaf");
});
