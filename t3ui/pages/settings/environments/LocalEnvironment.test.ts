import { expect, open, test } from "nsh/test";

test("turning it off confirms, saves, and (without a launcher) tells the user to restart by hand", async () => {
  const app = await open("./LocalEnvironmentFixture.tsx", { width: 700, height: 500 });
  await app.waitUntil(() => app.texts().includes("Local environment"));
  await app.press("label:Local environment");
  await app.waitUntil(() => app.texts().includes("Turn off local environment?"));
  await app.press("label:Restart and turn off");
  await app.waitUntil(() => app.texts().includes("Turned off. Agents only run in remote environments."));
  await app.waitUntil(() => app.texts().includes("Quit and reopen R3 Code to apply this change."));
});
