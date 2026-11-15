import { expect, open, test } from "nsh/test";

const options = { width: 320, height: 520, platform: "macos" as const };

test("dragging an active row onto Pinned pins it", async () => {
  const app = await open("./DragFixture.tsx", options);
  await app.drag("label:Active one, Demo", { y: -110 });
  await expect(app.texts()).toContain("Dropped: act pin pinned");
});

test("dragging an active row onto Settled settles it", async () => {
  const app = await open("./DragFixture.tsx", options);
  await app.drag("label:Active one, Demo", { y: 70 });
  await expect(app.texts()).toContain("Dropped: act settle settled");
});

test("dragging a pinned row onto Active unpins it", async () => {
  const app = await open("./DragFixture.tsx", options);
  await app.drag("label:Pinned one, Demo", { y: 90 });
  await expect(app.texts()).toContain("Dropped: pin unpin active");
});

test("dragging a settled row onto Active un-settles it", async () => {
  const app = await open("./DragFixture.tsx", options);
  await app.drag("label:Settled one, Demo", { y: -60 });
  await expect(app.texts()).toContain("Dropped: set unsettle active");
});

test("dropping a row in its own section does nothing", async () => {
  const app = await open("./DragFixture.tsx", options);
  await app.drag("label:Active one, Demo", { y: 10 });
  await expect(app.texts()).toContain("Dropped: none");
});

test("while dragging, the zones label themselves and a drop ends the drag", async () => {
  const app = await open("./DragFixture.tsx", options);
  await expect(app.texts()).not.toContain("Pinned");
  await app.dragAndHold("label:Active one, Demo", { y: 70 });
  await app.wait(100);
  await expect(app.texts()).toContain("Dragging from active");
  await expect(app.texts()).toContain("Pinned");
  await expect(app.texts()).toContain("Active");
  await app.drop();
  await expect(app.texts()).toContain("Dropped: act settle settled");
  await expect(app.texts()).toContain("Idle");
  await expect(app.texts()).not.toContain("Pinned");
});
