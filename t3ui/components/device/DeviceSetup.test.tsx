import { expect, open, test } from "nsh/test";

test("a failed host in the wizard says what to check and retries that host (DeviceHostUpdates, fm13)", async () => {
  const app = await open("./DeviceSetupFixture.tsx", { width: 700, height: 700 });
  await app.waitFor("text:ssh: connect to host timed out");
  await expect(app.texts()).toContain("Check the host connection and network access, then retry. Your device settings are saved.");
  await app.press("label:Retry Studio Mac");
  await app.waitUntil(() => app.texts().join("|").includes('device.list:{"retryHostId":"mac"}'));
});
