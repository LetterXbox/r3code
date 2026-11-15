import { expect, open, test } from "nsh/test";
import { easAccountInput, easAccountMessage, readEasAccount, readSimlockIdentity, simlockIdentityInput, simlockIdentityMessage, cleanSshHost, easDraftError, easSessionLimits, hostStatus, newEasHost, simlockDraftError, sshDraftError, updateEasHosts, updateSshHosts } from "./deviceSourcesLogic";

const mac = { kind: "ssh" as const, id: "h1", label: "Build Mac", target: "dev@mac.local" };

test("SSH hosts are added, edited in place and removed by identity, and a draft says what is wrong", () => {
  const added = updateSshHosts([], mac, false);
  expect(added).toEqual([mac]);
  expect(updateSshHosts(added, { ...mac, label: "Renamed" }, false, mac)).toEqual([{ ...mac, label: "Renamed" }]);
  expect(updateSshHosts(added, mac, true)).toEqual([]);
  expect(sshDraftError({ ...mac, label: "" })).toBe("Enter a name for this machine.");
  expect(sshDraftError({ ...mac, target: "-oProxyCommand=x" })).toContain("SSH destination");
  expect(sshDraftError({ ...mac, port: 70000 })).toBe("The port must be between 1 and 65535.");
  expect(sshDraftError(mac)).toBe(null);
  expect(cleanSshHost({ ...mac, label: " Build Mac ", identityFile: "  " })).toEqual(mac);
});

test("EAS hosts keep the saved token unless it changed, state their limits and validate them", () => {
  const host = { ...newEasHost("e1"), accessToken: "redacted" };
  expect(easSessionLimits(host)).toBe("Up to 2 sessions at once, each stopped after 30 min or 10 idle min");
  expect(updateEasHosts([host], { ...host, accessToken: "" }, false, true)[0]?.accessToken).toBe("redacted");
  expect(updateEasHosts([host], { ...host, accessToken: "new" }, false, false)[0]?.accessToken).toBe("new");
  expect(updateEasHosts([host], host, true)).toEqual([]);
  expect(easDraftError({ ...host, idleMinutes: 30 })).toBe("Idle minutes must be smaller than session minutes.");
  expect(easDraftError({ ...host, maxSessionMinutes: 200 })).toBe("Give the host a label and limits within the ranges shown.");
  expect(easDraftError({ ...host, label: " " })).toBe("Give the host a label and limits within the ranges shown.");
  expect(simlockDraftError({ kind: "simlock", id: "s", label: "", gatewayUrl: "https://g", agentToken: "", maxLeases: 2, maxLeaseMinutes: 60 })).toBe("Give the host a label.");
  expect(simlockDraftError({ kind: "simlock", id: "s", label: "Pool", gatewayUrl: "https://g", agentToken: "", maxLeases: 50, maxLeaseMinutes: 60 })).toBe("Keep the limits within the ranges shown.");
  expect(easDraftError(host)).toBe(null);
  expect(simlockDraftError({ kind: "simlock", id: "s", label: "Pool", gatewayUrl: "gateway", agentToken: "", maxLeases: 2, maxLeaseMinutes: 60 })).toContain("gateway's origin");
});

test("a host's status is empty while it works, and names a failure or an incomplete listing", () => {
  expect(hostStatus(null, "h1")).toEqual({ tone: "pending", label: "Loading" });
  expect(hostStatus({ hostStatuses: { h1: { status: "ready" } } }, "h1")).toBeUndefined();
  expect(hostStatus({ hostStatuses: { h1: { status: "ready", incompletePlatforms: ["ios"] } } }, "h1")?.label).toBe("iOS list may be incomplete");
  expect(hostStatus({ hostStatuses: { h1: { status: "starting", detail: "booting" } } }, "h1")).toEqual({ tone: "pending", label: "Starting", detail: "booting" });
  expect(hostStatus({ hostStatuses: { h1: { status: "failed", detail: "refused" } } }, "h1")).toEqual({ tone: "error", label: "Failed", detail: "refused" });
});

test("Devices lists the sources with their status, adds one over SSH and tests it", async () => {
  const app = await open("./DevicesFixture.tsx", { width: 1100, height: 2000 });
  await app.wait(120);
  for (const text of ["Device sources", "Local simulators", "Simulators and emulators installed on this environment's machine.", "Build Mac", "dev@mac.local", "Failed · connection refused"]) await expect(app.texts()).toContain(text);
  await app.press("label:Add source");
  await app.press("label:Machine over SSH");
  await app.type("label:Host name", "Lab Mac");
  await app.type("label:SSH destination", "lab@lab.local");
  await app.press("label:Save host");
  await app.wait(100);
  await expect(app.texts()).toContain("Lab Mac");
  await expect(app.texts()).toContain("lab@lab.local");
  await app.press("label:More for Build Mac");
  await app.press("label:Test connection");
  await app.wait(100);
  await expect(app.texts()).toContain(`call device.testHost {"kind":"ssh","id":"h1","label":"Build Mac","target":"dev@mac.local"}`);
});

test("the account checks send a typed token or the saved host and describe what answered", () => {
  expect(easAccountInput({ id: "e", accessToken: "redacted" }, " tok ", false)).toEqual({ accessToken: "tok" });
  expect(easAccountInput({ id: "e", accessToken: "redacted" }, "", false)).toEqual({ hostId: "e" });
  expect(easAccountInput({ id: "e", accessToken: "" }, "", true)).toEqual({});
  expect(easAccountMessage(readEasAccount({ signedInAs: "octo", credentialSource: "env", apps: [] })!)).toBe("Signed in as octo with EXPO_TOKEN on the server.");
  expect(readEasAccount({ signedInAs: "x", credentialSource: "bogus" })).toBe(null);
  expect(simlockIdentityInput({ id: "s", gatewayUrl: " https://g " }, "", false)).toEqual({ gatewayUrl: "https://g", hostId: "s" });
  expect(simlockIdentityMessage(readSimlockIdentity({ gatewayUrl: "g", signedInAs: "lab", tokenSource: "env" })!)).toBe("Using this machine's agent-device token (lab).");
  expect(simlockIdentityMessage(readSimlockIdentity({ gatewayUrl: "g", signedInAs: "lab", tokenSource: "entered" })!)).toBe("Accepted as lab.");
});

test("the EAS editor checks the Expo account and lists its projects", async () => {
  const app = await open("./DevicesFixture.tsx", { width: 1100, height: 2000 });
  await app.wait(100);
  await app.press("label:Add source");
  await app.press("label:EAS Simulator");
  await app.press("label:Check account");
  await app.wait(100);
  await expect(app.texts()).toContain("Signed in as octo with the server's eas login.");
  await expect(app.texts()).toContain("Add EAS host");
  await app.press("label:EAS project = __from-thread-project__");
  await expect(app.texts()).toContain("@octo/shop");
  await expect(app.texts()).toContain("From the thread's project");
});

test("the EAS editor checks the Expo account as it opens, without a press", async () => {
  const app = await open("./DevicesFixture.tsx", { width: 1100, height: 2000 });
  await app.wait(100);
  await app.press("label:Add source");
  await app.press("label:EAS Simulator");
  await app.wait(100);
  await expect(app.texts()).toContain("Signed in as octo with the server's eas login.");
  await expect(app.texts()).toContain("call device.easAccount {}");
});

test("an SSH host check reports its environment, a failure behind Show error, and a session without settings:write cannot test", async () => {
  const { checkSshHost } = await import("./DeviceSources");
  const { configureSettingsSync } = await import("./settingsSync");
  configureSettingsSync({ connected: () => true, request: () => Promise.reject(new Error("unused")) });
  const host = { kind: "ssh" as const, id: "h", label: "Lab", target: "lab@lab" };
  expect(await checkSshHost(host, () => Promise.resolve({ kind: "local" }), () => false)).toEqual({ status: "local" });
  expect(await checkSshHost(host, () => Promise.reject(new Error("refused")), () => false)).toEqual({ status: "failed", error: "refused" });
  expect(await checkSshHost(host, () => Promise.resolve({ kind: "remote" }), () => true)).toEqual({ status: "failed", error: "This connection cannot test device hosts." });
});

test("the device switches go through device.configure, and a failed configure names the environment", async () => {
  const app = await open("./DevicesFixture.tsx", { width: 1100, height: 2000 });
  await app.wait(100);
  await app.press("label:Agent device access");
  await app.wait(80);
  await expect(app.texts()).toContain(`call device.configure {"agentAccessEnabled":true}`);
  const { configureDevices } = await import("./DeviceSources");
  expect(await configureDevices({ enabled: true }, () => Promise.reject(new Error("down")), () => false)).toBe(false);
  expect(await configureDevices({ enabled: true }, () => Promise.resolve({}), () => true)).toBe(false);
});
