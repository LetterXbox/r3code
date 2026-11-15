import { expect, open, test } from "nsh/test";

test("links list with access and health, plus the error and empty states", async () => {
  const app = await open("./LinkedEnvironmentsFixture.tsx", { width: 900, height: 1400 });
  await app.waitUntil(() => app.texts().includes("VPS"));
  for (const text of [
    "Full access · Reachable",
    "Read only · Expires in 2 days. Link it again to renew.",
    "Supervised · Expired. Link it again with a new pairing code.",
    "Auto · Not answering right now.",
    "https://vps.example.ts.net",
    "Linked environments · Laptop",
    "Could not load linked environments",
    "Environment unreachable",
    "No linked environments",
    "Link another machine running T3 Code, such as a VPS, so agents here can launch and drive threads there.",
  ]) await expect(app.texts()).toContain(text);
});

test("Forget asks first, then unlinks and reloads", async () => {
  const app = await open("./LinkedEnvironmentsFixture.tsx", { width: 900, height: 1400 });
  await app.waitUntil(() => app.texts().includes("Down"));
  await app.press("label:Forget Down");
  await app.waitUntil(() => app.texts().includes("Forget Down?"));
  await app.press("label:Confirm");
  await app.waitUntil(() => app.texts().some((text) => text.includes('peerLinks.unlink {"environmentId":"down"}')));
  await app.waitUntil(() => !app.texts().includes("Down"));
});

test("Link sends the address, code and access, and reports a failure", async () => {
  const app = await open("./LinkedEnvironmentsFixture.tsx", { width: 900, height: 1400 });
  await app.waitUntil(() => app.texts().includes("VPS"));
  await app.press("label:Link >> nth=0");
  await expect(app.texts()).toContain("Link an environment");
  await app.type("label:Address", "https://box.example.ts.net");
  await app.type("label:Pairing code", "BAD");
  await app.press("label:Confirm link");
  await app.waitUntil(() => app.texts().includes("Could not link the environment"));
  await expect(app.texts()).toContain("The pairing code was rejected.");
  await app.clear("label:Pairing code");
  await app.type("label:Pairing code", "GOOD");
  // The access list opens inside the dialog (SettingsSelect inline) and its rows take the press.
  await app.press("label:What agents here may do there = approval-required");
  await app.press("label:Full access");
  await app.press("label:Confirm link");
  await app.waitUntil(() => app.texts().includes("Linked New box"));
  await expect(app.texts().some((text) => text.includes('peerLinks.link {"url":"https://box.example.ts.net","pairingCode":"GOOD","access":"full-access"}'))).toBe(true);
});
