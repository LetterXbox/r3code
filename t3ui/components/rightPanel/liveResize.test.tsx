// The drag overlay is window-sized: if it outlived its drag it would swallow every pointer event and
// the composer would stop taking keys. Every way a drag can end has to take it down.
import { expect, open, test } from "nsh/test";

const size = { width: 1280, height: 800, platform: "macos" } as const;

async function typesIntoComposer(app: Awaited<ReturnType<typeof open>>, text: string) {
  await app.type("label:Composer draft", text);
  await app.waitFor(`text:draft:${text}`);
}

async function panelOpen() {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle right panel");
  await app.waitFor("label:Resize right panel");
  await app.waitFor("text:panel-width:540");
  return app;
}

test("a finished right-panel drag leaves no overlay and the composer takes keys", async () => {
  const app = await panelOpen();
  await app.drag("label:Resize right panel", { x: -100 });
  await app.wait(50);
  await expect(app.shows("label:Resizing panel")).toBe(false);
  await typesIntoComposer(app, "hello");
});

test("while the drag is held the overlay follows, and a drop takes it down", async () => {
  const app = await panelOpen();
  await app.dragAndHold("label:Resize right panel", { x: -100 });
  await expect(app.shows("label:Resizing panel")).toBe(true);
  await app.drop();
  await app.wait(50);
  await expect(app.shows("label:Resizing panel")).toBe(false);
  await app.waitFor("text:panel-width:640");
  await typesIntoComposer(app, "after drop");
});

test("a finished and a dropped drawer drag leave no overlay either", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle terminal drawer");
  await app.waitFor("label:Resize terminal drawer");
  await app.drag("label:Resize terminal drawer", { y: -60 });
  await app.wait(50);
  await expect(app.shows("label:Resizing drawer")).toBe(false);
  await typesIntoComposer(app, "one");
  await app.dragAndHold("label:Resize terminal drawer", { y: -40 });
  await expect(app.shows("label:Resizing drawer")).toBe(true);
  await app.drop();
  await app.wait(50);
  await expect(app.shows("label:Resizing drawer")).toBe(false);
});

test("closing the panel mid-drag does not leave the drag overlay behind", async () => {
  const app = await panelOpen();
  await app.dragAndHold("label:Resize right panel", { x: -100 });
  await expect(app.shows("label:Resizing panel")).toBe(true);
  await app.press("label:Toggle right panel");
  await app.wait(50);
  await expect(app.shows("label:Resizing panel")).toBe(false);
  await app.drop();
  await typesIntoComposer(app, "after close");
});
