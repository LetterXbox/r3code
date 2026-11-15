import { expect, open, test } from "nsh/test";
import { AndroidFoldError, androidFoldView, changeAndroidFold, foldAngle, foldUrl, parseFold } from "./deviceFold";

const access = { httpBase: "http://h/api/device-hub", query: { hostId: "local", wsTicket: "T" } };
const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;

test("the fold endpoint, the payload check and the angle", () => {
  expect(foldUrl(access, "emu 1")).toBe("http://h/api/device-hub/vendor/serve-emu/api/fold?device=emu+1&hostId=local&wsTicket=T");
  expect(parseFold({ ok: true, fold: { supported: true, posture: "half_opened", hingeAngle: 90 } })).toEqual({ supported: true, posture: "half_opened", hingeAngle: 90 });
  expect(() => parseFold({ ok: true, fold: { supported: true, posture: "sideways", hingeAngle: null } })).toThrow("Unexpected Android fold response.");
  expect(foldAngle({ supported: true, posture: "closed", hingeAngle: null })).toBe(0);
  expect(foldAngle({ supported: true, posture: "opened", hingeAngle: null })).toBe(180);
  expect(foldAngle({ supported: true, posture: "tent", hingeAngle: 45 })).toBe(45);
});

test("a change renews an expired ticket once and records the hub's posture", async () => {
  const seen: string[] = [];
  const fetcher = (async (url: string) => { seen.push(url); return url.includes("wsTicket=T") ? reply(401, { error: "expired" }) : reply(200, { ok: true, fold: { supported: true, posture: "closed", hingeAngle: null } }); }) as typeof fetch;
  const key = "k-renew";
  const message = await changeAndroidFold({ deviceKey: key, access, deviceId: "e", posture: "closed", renewAccess: async () => ({ ...access, query: { hostId: "local", wsTicket: "U" } }) }, { fetcher });
  expect(message).toBeNull();
  expect(seen.length).toBe(2);
  expect(androidFoldView(key)()).toEqual({ fold: { supported: true, posture: "closed", hingeAngle: null }, angle: 0 });
});

test("a failed change rolls the optimistic angle back and says why", async () => {
  const key = "k-fail";
  androidFoldView(key).set({ fold: { supported: true, posture: "opened", hingeAngle: null }, angle: 180 });
  const fetcher = (async () => reply(500, { error: "emulator busy" })) as typeof fetch;
  expect(await changeAndroidFold({ deviceKey: key, access, deviceId: "e", posture: "closed", renewAccess: async () => null }, { fetcher })).toBe("emulator busy");
  expect(androidFoldView(key)().angle).toBe(180);
  const plain = (async () => reply(502, null)) as typeof fetch;
  expect(await changeAndroidFold({ deviceKey: key, access, deviceId: "e", posture: "closed", renewAccess: async () => null }, { fetcher: plain })).toBe("Fold command failed (502).");
  expect(new AndroidFoldError("x", 401).status).toBe(401);
});

test("the rail shows Fold and Unfold once the hub says the device folds, and Fold posts closed", async () => {
  const app = await open("./DeviceAndroidFoldFixture.tsx", { width: 400, height: 400, platform: "macos" });
  await app.waitFor("label:Fold device");
  await expect(app.shows("label:Unfold device")).toBe(true);
  await expect(app.texts().join("|")).toContain("GET http://h/api/device-hub/vendor/serve-emu/api/fold?device=emu-1&hostId=local&wsTicket=T");
  await app.press("label:Fold device");
  await app.waitUntil(() => app.texts().join("|").includes('POST http://h/api/device-hub/vendor/serve-emu/api/fold?device=emu-1&hostId=local&wsTicket=T {"posture":"closed"}'));
});
