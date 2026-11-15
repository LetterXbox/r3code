import { expect, open, test } from "nsh/test";

const size = { width: 1000, height: 900, platform: "macos" } as const;
const log = (app: { texts(): string[] }) => app.texts().join("|");

test("the rail has Home and Rotate device for an iOS simulator, disabled until the input socket admits input", async () => {
  const app = await open("./DeviceWorkspaceFixture.tsx", size);
  await app.waitFor("label:Device controls");
  await expect(app.shows("label:Home")).toBe(true);
  await expect(app.shows("label:Rotate device")).toBe(true);
  await expect(app.shows("label:Back")).toBe(false);
  // No input socket here (no server address): the press is refused as disabled.
  let refused = "";
  try { await app.press("label:Home"); } catch (cause) { refused = String(cause); }
  await expect(refused).toContain("disabled");
});

test("the overlaid device rail stays interactive when the host draws WebViews underneath", async () => {
  const app = await open("./DeviceWorkspaceFixture.tsx", size);
  await app.waitFor("label:Device controls");
  await app.press("label:Enable under-surface WebViews");
  await app.press("label:Device tools");
  await app.waitFor("label:Close tools");
  await app.press("label:Close tools");
  await app.press("label:More device actions");
  await app.waitFor("label:Float device over chat");
});

test("tools can open and close over a narrow device viewer", async () => {
  const app = await open("./DeviceWorkspaceFixture.tsx", { ...size, width: 500 });
  await app.waitFor("label:Device controls");
  await app.press("label:Enable under-surface WebViews");
  await app.press("label:Device tools");
  await app.waitFor("label:Close tools");
  await app.press("label:Close tools");
  await app.waitFor("label:Device controls");
});

test("Tools: App section reads the foreground app and opens a URL, location presets and permissions send device.action", async () => {
  const app = await open("./DeviceWorkspaceFixture.tsx", size);
  await app.waitFor("label:Device tools");
  await app.press("label:Device tools");
  await app.waitUntil(() => log(app).includes("com.example.app"));
  await expect(app.shows("text:Open an app first.")).toBe(false);
  await app.press("label:Terminate");
  await app.waitUntil(() => log(app).includes('"type":"terminateApp","appId":"com.example.app"'));
  await app.type("label:https://… or myapp://", "myapp://home");
  await app.press("label:Open");
  await app.waitUntil(() => log(app).includes('"type":"openUrl","url":"myapp://home"'));
  await app.press("label:Location preset = ");
  await app.press("label:Tokyo");
  await app.waitUntil(() => log(app).includes('"type":"setLocation","latitude":35.6762,"longitude":139.6503'));
  await app.press("label:Grant");
  await app.waitUntil(() => log(app).includes('"type":"setPermission","appId":"com.example.app","permission":"camera","decision":"grant"'));
  await app.press("label:Color filter = none");
  await app.press("label:Grayscale");
  await app.waitUntil(() => log(app).includes('"type":"setColorFilter","value":"grayscale"'));
  await app.press("label:Tinted");
  await app.waitUntil(() => log(app).includes('"type":"setLiquidGlass","value":"tinted"'));
  await app.type("label:Alert text", "Hello");
  await app.press("label:Send");
  await app.waitUntil(() => log(app).includes('"type":"sendPush","appId":"com.example.app","payload":"Hello"'));
});

test("the rail has Device text size, Save screenshot (disabled until the video streams) and More device actions (fm13)", async () => {
  const app = await open("./DeviceWorkspaceFixture.tsx", size);
  await app.waitFor("label:Device controls");
  await app.waitUntil(() => log(app).includes("device.detail"));
  await app.press("label:Device text size");
  await app.waitFor("label:Extra large");
  await app.press("label:Large");
  await app.waitUntil(() => log(app).includes('"type":"setTextSize","value":"large"'));
  let refused = "";
  try { await app.press("label:Save screenshot"); } catch (cause) { refused = String(cause); }
  await expect(refused).toContain("disabled");
  await app.press("label:More device actions");
  await app.waitFor("label:Float device over chat");
  await expect(app.shows("label:Close device panel")).toBe(true);
  await expect(app.shows("label:Power off device")).toBe(true);
});

test("the appearance control uses the loaded device setting", async () => {
  const app = await open("./DeviceWorkspaceFixture.tsx", size);
  await app.waitUntil(() => log(app).includes("device.detail"));
  await app.press("label:Switch device to dark mode");
  await app.waitUntil(() => log(app).includes('"type":"setAppearance","value":"dark"'));
});

test("segmented device settings update their current choice after an action", async () => {
  const app = await open("./DeviceWorkspaceFixture.tsx", size);
  await app.press("label:Device tools");
  await app.waitFor("label:Dark");
  await app.press("label:Dark");
  await app.waitUntil(() => log(app).includes('"type":"setAppearance","value":"dark"'));
  await app.press("label:Light");
  await app.waitUntil(() => log(app).includes('"type":"setAppearance","value":"light"'));
  await app.press("label:Tinted");
  await app.waitUntil(() => log(app).includes('"type":"setLiquidGlass","value":"tinted"'));
  await app.press("label:Clear >> nth=0");
  await app.waitUntil(() => log(app).includes('"type":"setLiquidGlass","value":"clear"'));
});

test("switching a device reloads its settings and sends actions to the new target", async () => {
  const app = await open("./DeviceWorkspaceFixture.tsx", size);
  await app.waitUntil(() => log(app).includes('device.detail:{"hostId":"local","deviceId":"S2"}'));
  await app.press("label:Switch device target");
  await app.waitUntil(() => log(app).includes('device.detail:{"hostId":"local","deviceId":"S3"}'));
  await app.press("label:Switch device to dark mode");
  await app.waitUntil(() => log(app).includes('"deviceId":"S3","type":"setAppearance","value":"dark"'));
});

test("Tools shows the device host's diagnostics (fm13)", async () => {
  const app = await open("./DeviceWorkspaceFixture.tsx", size);
  await app.press("label:Device tools");
  await app.waitFor("text:Host diagnostics");
  await expect(app.texts()).toContain("Android emulator discovery timed out.");
});
