// The Device panel's 3D presentation (DeviceStreamView.tsx `showPhone`, DevicePhoneViewport, DeviceDuoViewport,
// deviceModels.ts): the reference's three.js viewer and stream client bundled into one WebView page
// (third_party/t3-device-viewer, tools/build-device-viewer.mjs), and the device models as separate assets.
// The rail's 3D / Flat / Restore 3D view / Magic Keyboard controls live in DevicePanel.tsx.
import documentAsset from "./deviceViewerDocument.svg";
import iphone18Pro from "./models/iphone-18-pro.svg";
import iphone18ProMax from "./models/iphone-18-pro-max.svg";
import ipadPro13M5 from "./models/ipad-pro-13-m5.svg";
import magicKeyboard from "./models/ipad-pro-13-m5-magic-keyboard.svg";
import iphoneDuo from "./models/iphone-duo.svg";
import type { DevicePlatform } from "./deviceLogic";
import type { DeviceHubAccess } from "./deviceStream";

export type DeviceModelId = "iphone-18-pro" | "iphone-18-pro-max" | "ipad-pro-13-m5" | "iphone-duo";

/** client-runtime device/model.ts resolveDeviceModelId. */
export function resolveDeviceModelId(platform: DevicePlatform, name: string): DeviceModelId | null {
  if (platform !== "ios") return null;
  if (/^iPhone Duo$/i.test(name)) return "iphone-duo";
  if (/^iPhone 18 Pro Max$/i.test(name)) return "iphone-18-pro-max";
  if (/^iPhone 18 Pro$/i.test(name)) return "iphone-18-pro";
  if (/^iPad Pro 13-inch \(M5\)$/i.test(name)) return "ipad-pro-13-m5";
  return null;
}

/** deviceKeyboard: the iPad Pro 13-inch (M5) has the Magic Keyboard accessory. */
export const hasDeviceKeyboard = (platform: DevicePlatform, name: string) => resolveDeviceModelId(platform, name) === "ipad-pro-13-m5";

const MODEL_ASSETS: Record<DeviceModelId | "ipad-pro-13-m5-magic-keyboard", { url: string }> = {
  "iphone-18-pro": iphone18Pro, "iphone-18-pro-max": iphone18ProMax, "ipad-pro-13-m5": ipadPro13M5, "ipad-pro-13-m5-magic-keyboard": magicKeyboard, "iphone-duo": iphoneDuo,
};

/**
 * DeviceStreamView's phoneUnavailableReason, in the reference's order. `mjpeg` is true when the page fell back to the
 * MJPEG feed, which the port also uses for the flat view.
 */
export function phoneUnavailableReason(input: { isDuo: boolean; supportsHingeAngle: boolean; phoneUnavailable: boolean; mjpeg: boolean; axOverlay: boolean }): string | null {
  if (input.isDuo && !input.supportsHingeAngle) return "iPhone Duo 3D requires Device Hub 0.11.0 or newer";
  if (input.phoneUnavailable) return "3D is unavailable on this browser";
  if (input.mjpeg) return "3D requires the H.264 stream";
  if (input.axOverlay) return "Turn off accessibility frames to use 3D";
  return null;
}

/** ws(s) twin of the hub's http(s) base (client-runtime DeviceHubAccess.wsBase). */
export const hubWsBase = (httpBase: string) => httpBase.replace(/^http/, "ws");

export interface DeviceViewerConfig {
  platform: DevicePlatform;
  deviceId: string;
  deviceName: string;
  serveSimOnly: boolean;
  access: DeviceHubAccess;
  keyboardAttached: boolean;
  foldAngle: number | null;
}

/** The page: the bundled document with the device's config and its models (base64 .glb) written in. */
export function viewerPage(document: string, config: DeviceViewerConfig, models: { model: string | null; accessory: string | null }): string {
  const payload = {
    platform: config.platform, deviceId: config.deviceId, deviceName: config.deviceName, serveSimOnly: config.serveSimOnly,
    access: { httpBase: config.access.httpBase, wsBase: hubWsBase(config.access.httpBase), query: config.access.query, credentials: false },
    model: models.model, accessory: models.accessory, keyboardAttached: config.keyboardAttached, foldAngle: config.foldAngle,
  };
  // `<` escaped so nothing in the payload can close the script element.
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  return document.replace("__T3_VIEWER_CONFIG__", () => json);
}

async function metadataOf(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Could not load the 3D device viewer");
  const match = (await response.text()).match(/<metadata>([A-Za-z0-9+/=]+)<\/metadata>/);
  if (!match) throw new Error("The 3D device viewer asset is invalid");
  return match[1]!;
}

let documentCache: Promise<string> | undefined;
const modelCache = new Map<string, Promise<string>>();
let override: ((name: string) => Promise<string>) | null = null;

/** Tests give the assets themselves (a headless run cannot fetch the bundled ones); null goes back to the assets. */
export function overrideViewerAssets(load: ((name: string) => Promise<string>) | null) { override = load; documentCache = undefined; modelCache.clear(); }

export function loadViewerDocument(): Promise<string> {
  if (!documentCache) {
    documentCache = (override ? override("document") : metadataOf(documentAsset.url).then((b64) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))))
      .catch((error: unknown) => { documentCache = undefined; throw error; });
  }
  return documentCache;
}

/** The base64 .glb of a model or the keyboard accessory. */
export function loadViewerModel(id: keyof typeof MODEL_ASSETS): Promise<string> {
  let cached = modelCache.get(id);
  if (!cached) {
    cached = (override ? override(id) : metadataOf(MODEL_ASSETS[id].url)).catch((error: unknown) => { modelCache.delete(id); throw error; });
    modelCache.set(id, cached);
  }
  return cached;
}

/** The whole page for a device: document, its model and (iPad) the keyboard accessory. */
export async function buildViewerPage(config: DeviceViewerConfig): Promise<string> {
  const id = resolveDeviceModelId(config.platform, config.deviceName);
  const [document, model, accessory] = await Promise.all([
    loadViewerDocument(),
    id ? loadViewerModel(id) : Promise.resolve(null),
    id === "ipad-pro-13-m5" ? loadViewerModel("ipad-pro-13-m5-magic-keyboard") : Promise.resolve(null),
  ]);
  return viewerPage(document, config, { model, accessory });
}

/** What the page reports (entry.ts `post`). */
export interface ViewerReport {
  t3: "viewer";
  ready?: boolean;
  status?: "connecting" | "streaming" | "error";
  detail?: string | null;
  screen?: { width: number; height: number; orientation: string; screenId?: number; supportsHingeAngle?: boolean; hingeAngle?: number; hingePose?: string | null; tableMode?: boolean; tableModeAvailable?: boolean };
  input?: { connected: boolean; detail: string | null };
  duoControl?: { pending: boolean; requested: { control: string; value: unknown } | null; error: string | null };
  phoneUnavailable?: boolean;
  mjpegUrl?: string | null;
  unauthorized?: boolean;
  modelError?: string;
  pageError?: string;
}

export function readViewerReport(data: string): ViewerReport | null {
  try { const m = JSON.parse(data) as ViewerReport; return m && m.t3 === "viewer" ? m : null; } catch { return null; }
}

/** The port's MJPEG-only hub path: a 3D page with no frame after this long gives way to the flat view. */
export const VIEWER_FIRST_FRAME_MS = 10_000;
let firstFrameMs = VIEWER_FIRST_FRAME_MS;
export const viewerFirstFrameMs = () => firstFrameMs;
/** Tests shorten the wait; null restores it. */
export function overrideViewerFirstFrameMs(ms: number | null) { firstFrameMs = ms ?? VIEWER_FIRST_FRAME_MS; }
