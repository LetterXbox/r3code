import { expect, open, test } from "nsh/test";

const size = { width: 700, height: 600, platform: "macos" } as const;

test("the Device panel lists simulators grouped by platform and Start opens one for the thread", async () => {
  const app = await open("./DevicePanelFixture.tsx", size);
  await app.waitFor("label:iOS Simulators");
  await expect(app.shows("text:iPhone SE")).toBe(true);
  await expect(app.shows("text:This machine · 17.2 · Running")).toBe(true);
  await app.press("label:Start iPhone 15");
  await app.waitUntil(() => app.texts().join("|").includes("opened:iPhone 15"));
  await expect(app.texts().join("|")).toContain('device.open:{"threadId":"t1","hostId":"local","deviceId":"S1","platform":"ios"}');
});

test("Refresh devices asks the server to list again", async () => {
  const app = await open("./DevicePanelFixture.tsx", size);
  await app.waitFor("label:Refresh devices");
  await app.press("label:Refresh devices");
  await app.waitUntil(() => app.texts().join("|").includes("device.list:{}"));
});

test("repeated device state pushes do not re-probe with device.list each time", async () => {
  const app = await open("./DevicePanelFixture.tsx", size);
  // The fixture's subscribe pushes four snapshots (same hostStatus, growing revision) to stand in for the
  // server's progress updates while a device boots; the panel's own startup probe must fire once, not once per push.
  await app.waitFor("label:iOS Simulators");
  await app.waitUntil(() => {
    const text = app.texts().join("|");
    return (text.match(/device\.list:\{\}/g) ?? []).length >= 1;
  });
  const countAfterFirst = (app.texts().join("|").match(/device\.list:\{\}/g) ?? []).length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  const countLater = (app.texts().join("|").match(/device\.list:\{\}/g) ?? []).length;
  await expect(countLater).toBe(countAfterFirst);
  await expect(countLater).toBe(1);
});
