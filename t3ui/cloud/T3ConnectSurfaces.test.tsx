import { expect, open, test } from "nsh/test";

test("T3 Connect rows, the onboarding dialog and the phone band render the reference's copy", async () => {
  const app = await open("./T3ConnectFixture.tsx", { width: 900, height: 1200 });
  await expect(app.texts()).toContain("Box a");
  await expect(app.texts()).toContain("Relay encountered an internal error (subject rejected).");
  await expect(app.texts()).toContain("Add route");
  await app.press("label:Set up");
  await expect(app.texts()).toContain("Signed in. Share this computer so the app can reach it.");
  await app.press("label:open-onboarding");
  await expect(app.texts()).toContain("Set up T3 Connect");
  await expect(app.texts()).toContain("Mesh your devices together. Publish this environment and connect the rest, all in one place.");
  await expect(app.texts()).toContain("Don't show this again");
  await app.press("label:Done");
});
