// The occlusion registry is empty whenever nothing floats: a leaked registration would hide every WebView for good.
import { expect, open, test } from "nsh/test";

const overlays = (app: { texts(): string[] }) => app.texts().find((text) => text.startsWith("overlays:")) ?? "";

test("nothing is registered at rest", async () => {
  const app = await open("./OcclusionAuditFixture.tsx", { width: 1280, height: 800 });
  await app.wait(300);
  await expect(overlays(app)).toBe("overlays:[]");
});

test("the palette, settings and a composer popup release on close", async () => {
  const app = await open("./OcclusionAuditFixture.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+k");
  await app.waitUntil(() => app.texts().includes("Open settings"), { timeout: 5000 });
  await app.keyboard.press("Escape");
  await app.waitUntil(() => !app.texts().includes("Open settings") && overlays(app) === "overlays:[]", { timeout: 5000 });
  await app.keyboard.press("mod+,");
  await app.wait(300);
  await app.keyboard.press("mod+,");
  await app.waitUntil(() => overlays(app) === "overlays:[]", { timeout: 5000 });
  await app.press("label:New thread");
  await app.type("id:composer-prompt", "/");
  await app.wait(300);
  await app.clear("id:composer-prompt");
  await app.keyboard.press("Escape");
  await app.waitUntil(() => overlays(app) === "overlays:[]", { timeout: 5000 });
  await expect(overlays(app)).toBe("overlays:[]");
});
