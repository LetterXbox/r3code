import { expect, open, test } from "nsh/test";

const options = { width: 1280, height: 800, platform: "macos" as const };
const KEY = "chat_thread_sidebar_width";

test("the sidebar has a resize edge", async () => {
  const app = await open("../../App.tsx", options);
  await expect(app.shows("label:Resize Sidebar")).toBe(true);
});

test("dragging the edge saves the new width", async () => {
  const app = await open("../../App.tsx", options);
  await app.drag("label:Resize Sidebar", { x: 80 });
  await app.wait(50);
  await expect(app.storage()[KEY]).toBe("336");
});

test("the width never goes under 13rem", async () => {
  const app = await open("../../App.tsx", options);
  await app.drag("label:Resize Sidebar", { x: -200 });
  await app.wait(50);
  await expect(app.storage()[KEY]).toBe("208");
});

test("a saved width is used the next time", async () => {
  const app = await open("../../App.tsx", { ...options, storage: { [KEY]: "320" } });
  await app.wait(100);
  await app.drag("label:Resize Sidebar", { x: 20 });
  await app.wait(50);
  await expect(app.storage()[KEY]).toBe("340");
});

test("a press that does not move the edge saves nothing, and dragging back to 16rem clears the saved width", async () => {
  const app = await open("../../App.tsx", options);
  await app.drag("label:Resize Sidebar", { x: 0 });
  await app.wait(50);
  await expect(app.storage()[KEY]).toBeUndefined();
  await app.drag("label:Resize Sidebar", { x: 80 });
  await app.wait(50);
  await expect(app.storage()[KEY]).toBe("336");
  await app.drag("label:Resize Sidebar", { x: -80 });
  await app.wait(50);
  await expect(app.storage()[KEY]).toBeUndefined();
});
