import { expect, open, test } from "nsh/test";
import { backendUrl, configureBackend } from "../../store";
import { addEnvironment, parseRemotePairingFields, resetSavedEnvironments, savedEnvironments, savedEnvironmentStatus } from "./environments/savedEnvironments";

// The page, not the whole app: each open of App.tsx evaluated ~9.8 MB of bytecode (2.5 s on an idle machine, far more under
// load) and the first one also bundled and compiled it inside its own 30 s budget. Opening Settings with mod+, is covered
// by the app-level settings tests.
async function openEnvironments() {
  const app = await open("./EnvironmentsPageFixture.tsx", { width: 1280, height: 900 });
  await app.waitFor("text:This app");
  return app;
}

test("Environments shows This app, the empty list and an Add environment dialog above the page", async () => {
  const app = await openEnvironments();
  for (const text of ["This app", "Local environment", "Environments", "No saved remote environments", "Click “Add environment” to pair another environment, or connect one from T3 Connect."]) await expect(app.texts()).toContain(text);
  await app.press("label:Add environment");
  for (const text of ["Add Environment", "Pair another environment to this client.", "Remote link", "Enter a backend host and pairing code.", "Host", "Pairing code", "Paste a full pairing URL here to fill both fields automatically."]) await expect(app.texts()).toContain(text);
});

test("a pasted pairing link fills the host and pairing code, and empty or bad input is refused with the web's copy", async () => {
  const app = await openEnvironments();
  await app.press("label:Add environment");
  await app.press("label:Confirm add environment");
  await expect(app.texts()).toContain("Enter a backend host.");
  await app.type("label:Host", "https://backend.example.com/pair#token=ABC123");
  await expect(app.value("label:Host")).toBe("backend.example.com");
  await expect(app.value("label:Pairing code")).toBe("ABC123");
  await app.clear("label:Host");
  await app.type("label:Host", "ht!tp://");
  await app.press("label:Confirm add environment");
  await expect(app.texts()).toContain("Enter the backend host, such as backend.example.com.");
});

test("the Local environment switch asks before it changes, in a modal", async () => {
  const app = await openEnvironments();
  await app.press("label:Local environment");
  await expect(app.texts()).toContain("Turn off local environment?");
  await expect(app.texts()).toContain("Restart and turn off");
  await app.press("label:Cancel");
  await expect(app.texts()).not.toContain("Turn off local environment?");
});

test("pairing fields follow parseRemotePairingFields and the row status follows SavedBackendListRow", () => {
  expect(() => parseRemotePairingFields({ host: " ", pairingCode: "x" })).toThrow("Enter a backend host.");
  expect(() => parseRemotePairingFields({ host: "backend.example.com", pairingCode: " " })).toThrow("Enter a pairing code.");
  expect(parseRemotePairingFields({ host: "https://h.example.com/pair#token=T1", pairingCode: "" })).toEqual({ host: "h.example.com", pairingCode: "T1" });
  const env = { id: "a", label: "h", url: "wss://h/ws", enabled: true, addedAt: 0 };
  expect(savedEnvironmentStatus(env, undefined)).toEqual({ text: "Not connected", tone: "muted" });
  expect(savedEnvironmentStatus(env, { phase: "connected" }).text).toBe("Connected");
  expect(savedEnvironmentStatus(env, { phase: "failed", error: "HTTP 401" })).toEqual({ text: "Connection failed: HTTP 401", tone: "error" });
  expect(savedEnvironmentStatus({ ...env, enabled: false }, { phase: "connected" }).text).toBe("Off");
});

test("adding an environment while connected never replaces the live connection", async () => {
  resetSavedEnvironments();
  configureBackend("ws://127.0.0.1:3777/ws");
  let failed = false;
  try { await addEnvironment({ host: "127.0.0.1:1", pairingCode: "CODE" }); } catch { failed = true; }
  expect(failed).toBe(true);
  expect(backendUrl()).toBe("ws://127.0.0.1:3777/ws");
  expect(savedEnvironments().length).toBe(0);
  let duplicate = "";
  try { await addEnvironment({ host: "ws://127.0.0.1:3777/ws", pairingCode: "CODE" }); } catch (error) { duplicate = (error as Error).message; }
  expect(duplicate).toBe("That environment is already added.");
  configureBackend("");
});

test("Routes lists a saved environment's routes preferred first; the grip reorders, Remove asks first, Hide routes closes", async () => {
  const app = await open("./EnvironmentRoutesFixture.tsx", { width: 1100, height: 1000 });
  await app.press("label:More actions for Box");
  await app.press("label:Routes");
  await app.waitFor("label:Routes to Box, preferred first");
  for (const text of ["box.example.com", "https://box.example.com", "LAN", "http://192.168.1.4:3773", "Add route"]) await expect(app.texts()).toContain(text);
  await app.drag("label:Reorder LAN, position 2", { x: 0, y: -44 });
  await app.waitUntil(() => app.texts().includes("preferred ws://192.168.1.4:3773/ws · 2 routes"));
  await app.press("label:Remove box.example.com route");
  await app.waitUntil(() => app.texts().includes("Remove box.example.com route?"));
  await app.press("label:Confirm");
  await app.waitUntil(() => app.texts().includes("preferred ws://192.168.1.4:3773/ws · 1 routes"));
  await expect(app.count("label:Remove LAN route")).toBe(0);
  await app.press("label:Add route");
  await app.waitUntil(() => app.texts().includes("Add a route to Box"));
  await app.press("label:Close");
  await app.press("label:More actions for Box");
  await app.press("label:Hide routes");
  await app.waitFor("label:Routes to Box, preferred first", { state: "gone" });
});

test("a saved environment's Permissions list reads its own session and names the route it applies to", async () => {
  const app = await open("./SavedPermissionsFixture.tsx", { width: 900, height: 600 });
  await expect(app.texts()).toContain("These permissions apply to your active route. Other routes may have different permissions.");
  await expect(app.texts()).toContain("Allowed");
  await expect(app.texts()).toContain("Not granted");
});

test("the SSH mode shows its fields, pairs through the SSH flow and saves the tunnel route", async () => {
  const app = await openEnvironments();
  await app.press("label:Add environment");
  await app.press("label:SSH");
  for (const text of ["SSH host or alias", "Username", "Port", "Use local SSH config, agent, and tunnels for the backend."]) await expect(app.texts()).toContain(text);
  const { setSshDraftForTest, submitSshAdd, sshAddErrorForTest } = await import("./Connection");
  setSshDraftForTest({ host: "ada@devbox" });
  const saved: unknown[] = [];
  await submitSshAdd({
    ensure: async (target, localPort) => ({ httpBaseUrl: `http://127.0.0.1:${localPort}/`, wsBaseUrl: `ws://127.0.0.1:${localPort}/`, pairingToken: "PAIR", remotePort: 4100 }),
    deps: () => ({ runner: {} as never, cliRunner: { archiveVersion: "1.2.3" } }),
    save: async (input) => { saved.push(input); return {} as never; },
  });
  expect(sshAddErrorForTest()).toBe("");
  const entry = saved[0] as { label: string; address: string; pairingToken: string; ssh: { target: { alias: string; username: string } } };
  expect(entry.label).toBe("devbox");
  expect(entry.address.startsWith("ws://127.0.0.1:")).toBe(true);
  expect(entry.ssh.target.username).toBe("ada");
  setSshDraftForTest({ host: "devbox" });
  await submitSshAdd({ ensure: async () => { throw new Error("SshLaunchError: Remote node is missing."); }, deps: () => ({ runner: {} as never, cliRunner: {} }) });
  expect(sshAddErrorForTest()).toBe("Remote node is missing.");
  // provisionDesktopSshEnvironment: the host's descriptor names it; a reused server on another build that refuses the pairing says so.
  const named: unknown[] = [];
  const ensure = async (_target: unknown, localPort: number) => ({ httpBaseUrl: `http://127.0.0.1:${localPort}/`, wsBaseUrl: `ws://127.0.0.1:${localPort}/`, pairingToken: "PAIR", remotePort: 4100 });
  setSshDraftForTest({ host: "devbox" });
  await submitSshAdd({ ensure, deps: () => ({ runner: {} as never, cliRunner: {} }), describe: async () => ({ label: "Build box", serverVersion: "1.0.0" }), save: async (input) => { named.push(input); return {} as never; } });
  expect((named[0] as { label: string }).label).toBe("Build box");
  const { sshPairingVersionError } = await import("./Connection");
  expect((sshPairingVersionError(new Error("Pairing failed (HTTP 500)"), { label: "Build box", serverVersion: "1.0.0" }, "1.1.0") as Error).message)
    .toBe("Build box runs T3 Code 1.0.0, but this desktop is 1.1.0, and that server could not accept its pairing. Restart the T3 server on Build box so it runs 1.1.0, then retry.");
  const same = new Error("Pairing failed (HTTP 500)");
  expect(sshPairingVersionError(same, { label: "Build box", serverVersion: "1.1.0" }, "1.1.0")).toBe(same);
});

test("the connection diagnosis panel lists the hops and what to try, retries and copies the report", async () => {
  const app = await open("./DiagnosisPanelFixture.tsx", { width: 900, height: 700 });
  for (const text of ["This device", "Not checked", "T3 Code on Build box", "Failed", "What to try", "1. Make sure T3 Code is running on Build box.", "Route", "Direct"]) await expect(app.texts()).toContain(text);
  await app.press("label:Retry now");
  await expect(app.texts()).toContain("retried 1");
  await app.press("label:Copy diagnostics");
  await expect(app.texts()).toContain("Diagnostics copied");
  await expect(app.texts()).toContain("T3 Code connection to Build box: T3 Code on Build box did not answer");
});
