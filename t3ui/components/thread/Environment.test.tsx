import { expect, open, test } from "nsh/test";

test("the Run on control names the machine, opens on composer.host, and picks another", async () => {
  const app = await open("./EnvironmentFixture.tsx", { width: 600, height: 400, platform: "macos" });
  await expect(app.texts()).toContain("Laptop");
  await app.press("label:Host shortcut");
  await app.waitUntil(() => app.texts().includes("Run on"));
  await app.press("label:Studio");
  await app.waitUntil(() => app.texts().includes("picked:Studio"));
});

test("with load balancing on, Run on offers Auto balance first and the trigger shows the routing state", async () => {
  const app = await open("./EnvironmentFixture.tsx", { width: 700, height: 500 });
  await app.press("label:Offer auto");
  await app.press("label:Run on");
  await app.waitFor("text:Auto balance");
  await app.press("text:Auto balance");
  await app.waitUntil(() => app.texts().includes("picked:auto"));
  await app.waitUntil(() => app.texts().includes("Checking machines…"));
  await app.press("label:Balanced");
  await app.waitUntil(() => app.texts().includes("Auto balance"));
  await expect(app.texts()).not.toContain("Checking machines…");
});
