import { expect, open, test } from "nsh/test";

test("This machine shows the environment, its Version and the bridge-less Network access row", async () => {
  const app = await open("./AccessPanelFixture.tsx", { width: 1000, height: 1000 });
  for (const text of ["Studio Mac", "Version", "1.2.3 · 10.0.0.9:3773", "Up to date", "Network access", "Only this machine can connect. Restart with a non-loopback host for remote pairing.", "Permissions"]) await expect(app.texts()).toContain(text);
  // The app now ships the T3 Connect public config, so CloudLinkRow shows; without a link state saying this session may
  // link from here (linkableHere) the reference points at the host's CLI, and the webhook row needs an active tunnel.
  await expect(app.texts()).toContain("Run `t3 connect link` on the host, then restart T3 Code there.");
  await expect(app.texts()).not.toContain("Hold webhooks while offline");
  await app.press("label:Policy remote");
  await expect(app.texts()).toContain("Remote access is already configured. Change network exposure where the server starts.");
  await app.press("label:Policy unknown");
  await expect(app.texts()).toContain("Network exposure information is unavailable.");
});

test("Permissions lists what this session holds; without a connection it says so", async () => {
  const app = await open("./AccessPanelFixture.tsx", { width: 1000, height: 1000 });
  await app.press("label:Permissions");
  await expect(app.texts()).toContain("Connect to this environment to view this session’s permissions.");
});

test("Authorized clients folds the newest link under the header, with its Share button, and carries the MCP entry", async () => {
  const app = await open("./AccessPanelFixture.tsx", { width: 1000, height: 1000 });
  await expect(app.texts()).toContain("0 clients · 1 pairing link");
  for (const text of ["Use in another app (MCP)", "Revoke others", "Create link"]) await expect(app.texts()).toContain(text);
  await app.press("label:Authorized clients");
  await expect(app.texts()).toContain("iPad");
  await expect(app.texts()).toContain("1 scope");
});

test("a session with access:write alone can create links but not view clients, and one with neither has no Authorized clients", async () => {
  const app = await open("./AccessPanelFixture.tsx", { width: 1000, height: 1000 });
  await app.press("label:Session write only");
  await expect(app.texts()).toContain("Create link");
  await app.press("label:Authorized clients");
  await expect(app.texts()).toContain("This connection can create access links but cannot view authorized clients.");
  await app.press("label:Session none");
  await expect(app.texts()).not.toContain("Authorized clients");
});

test("the machine menu lists the icons, and a pick writes environmentIcon unless it is what the server detected", async () => {
  const app = await open("./AccessPanelFixture.tsx", { width: 1000, height: 1000 });
  await app.press("label:More actions for this machine");
  for (const label of ["Server", "Cloud VM", "Linux/WSL", "Desktop", "Laptop", "Mini PC", "Workstation"]) await expect(app.shows(`label:${label}`)).toBe(true);
});
