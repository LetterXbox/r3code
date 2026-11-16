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

test("connectedPeerLinkHosts includes connected saved remotes offering peer links even when primary does not", async () => {
  const { connectedPeerLinkHosts } = await import("./LinkedEnvironments");
  const { savedEnvironments, resetSavedEnvironments } = await import("./savedEnvironments");
  const { environmentConfigs, environmentConnections, resetEnvironmentsForTest } = await import("../../../environments/connectionManager");
  const { observeServerConfigEvent, resetServerConfig } = await import("../settingsState");

  resetSavedEnvironments();
  resetEnvironmentsForTest();
  resetServerConfig();
  try {
    observeServerConfigEvent({ type: "snapshot", config: { settings: { linkedEnvironmentsEnabled: false }, keybindings: [], environment: { label: "R3 Code", capabilities: { peerLinks: true } } } });
    savedEnvironments.set([
      { id: "saved:1", label: "gx10-3053", url: "ws://127.0.0.1:13774/ws", enabled: true, addedAt: 1 },
      { id: "saved:2", label: "Offline box", url: "ws://127.0.0.1:13775/ws", enabled: true, addedAt: 2 },
      { id: "saved:3", label: "Labs off", url: "ws://127.0.0.1:13776/ws", enabled: true, addedAt: 3 },
    ]);
    environmentConnections.set({
      "saved:1": { phase: "connected", error: null },
      "saved:2": { phase: "reconnecting", error: null },
      "saved:3": { phase: "connected", error: null },
    });
    environmentConfigs.set({
      "saved:1": { environment: { label: "Remote 1", capabilities: { peerLinks: true } }, settings: { linkedEnvironmentsEnabled: true } },
      "saved:2": { environment: { label: "Remote 2", capabilities: { peerLinks: true } }, settings: { linkedEnvironmentsEnabled: true } },
      "saved:3": { environment: { label: "Remote 3", capabilities: { peerLinks: true } }, settings: { linkedEnvironmentsEnabled: false } },
    });

    const hosts = connectedPeerLinkHosts();
    expect(hosts.map((host) => ({ key: host.key, label: host.label }))).toEqual([
      { key: "saved:1", label: "gx10-3053" },
    ]);
  } finally {
    resetSavedEnvironments();
    resetEnvironmentsForTest();
    resetServerConfig();
  }
});
