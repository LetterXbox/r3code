import { expect, open, test } from "nsh/test";

test("slow model loading does not trigger the video fallback and hiding does not reload the model", async () => {
  const app = await open("./DevicePhoneLifecycleFixture.tsx", { width: 600, height: 700, platform: "macos" });
  await app.waitFor("text:assets:2 fallback:0");
  await app.wait(550);
  expect(app.shows("text:assets:2 fallback:0")).toBe(true);
  await app.wait(180);
  await app.press("text:Toggle visibility");
  await app.press("text:Toggle visibility");
  // HTML exists, but this fixture's WebView never reports ready. It gets a
  // startup deadline distinct from the first-frame deadline.
  await app.wait(350);
  expect(app.shows("text:assets:2 fallback:0")).toBe(true);
  await app.waitFor("text:assets:2 fallback:1");
});

test("switching device during model loading opens only the new device", async () => {
  const app = await open("./DevicePhoneLifecycleFixture.tsx", { width: 600, height: 700, platform: "macos" });
  await app.waitFor("text:assets:2 fallback:0");
  await app.press("text:Switch device");
  await app.waitFor("text:access:remote");
  expect(app.shows("text:access:local,remote")).toBe(false);
});

test("switching device after loading reconnects the viewer", async () => {
  const app = await open("./DevicePhoneLifecycleFixture.tsx", { width: 600, height: 700, platform: "macos" });
  await app.waitFor("text:access:local");
  await app.press("text:Switch device");
  await app.waitFor("text:access:local,remote");
});
