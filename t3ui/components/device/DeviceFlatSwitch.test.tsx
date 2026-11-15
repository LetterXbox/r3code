import { open, test } from "nsh/test";

test("the flat stream reconnects when its device changes", async () => {
  const app = await open("./DeviceFlatSwitchFixture.tsx", { width: 600, height: 700, platform: "macos" });
  await app.waitFor("text:access:local");
  await app.press("text:Switch device");
  await app.waitFor("text:access:local,remote");
});
