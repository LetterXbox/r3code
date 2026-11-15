// deviceHubApi.ts (components/device): the device hub's accessibility tree (polled, deviceHubAtoms.ts AX_POLL_INTERVAL_MS),
// its event log and foreground-app streams (Server-Sent Events). The tree is fetched here; the two streams need an
// EventSource, which NSH has only inside a WebView page, so the stream page opens them (deviceInputPage.ts) and posts the
// parsed data back. Pure parts are unit tested.
import { withHubQuery, type DeviceHubAccess } from "./deviceStream";
import type { DevicePlatform } from "./deviceLogic";

export interface DeviceAxElement { id: string; label: string; role: string; x: number; y: number; width: number; height: number }
export interface DeviceAxTree { elements: DeviceAxElement[]; errors: string[] }
export interface DeviceEventLogEntry { id: number; timestamp: string; kind: string; summary: string }
export interface DeviceHubTarget { access: DeviceHubAccess; platform: DevicePlatform; deviceId: string }

export const AX_POLL_INTERVAL_MS = 2_000;
export const DEVICE_EVENT_LOG_LIMIT = 100;
const AX_ELEMENT_LIMIT = 500;

const vendorBase = (t: DeviceHubTarget) => `${t.access.httpBase}${t.platform === "ios" ? "/vendor/serve-sim" : "/vendor/serve-emu"}`;
export const hubUrl = (t: DeviceHubTarget, path: string, params?: Record<string, string>) =>
  withHubQuery(`${vendorBase(t)}${path}${params ? `?${new URLSearchParams(params).toString()}` : ""}`, t.access.query);

export const eventLogUrl = (t: DeviceHubTarget) => hubUrl(t, "/api/event-log/events", { device: t.deviceId, limit: "100" });
export const foregroundUrl = (t: DeviceHubTarget) => hubUrl(t, "/appstate", { device: t.deviceId });
export const axUrl = (t: DeviceHubTarget) => (t.platform === "ios" ? hubUrl(t, `/helper/${encodeURIComponent(t.deviceId)}/ax`) : hubUrl(t, "/api/accessibility", { device: t.deviceId }));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const numberOr = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

function flattenIosAxTree(roots: unknown[]): DeviceAxElement[] {
  const first = roots[0];
  const rootFrame = isRecord(first) && isRecord(first.frame) ? first.frame : null;
  const sw = Math.max(1, numberOr(rootFrame?.width, 1));
  const sh = Math.max(1, numberOr(rootFrame?.height, 1));
  const elements: DeviceAxElement[] = [];
  const visit = (node: unknown, path: string) => {
    if (elements.length >= AX_ELEMENT_LIMIT || !isRecord(node) || !isRecord(node.frame)) return;
    const frame = node.frame;
    const width = numberOr(frame.width, 0); const height = numberOr(frame.height, 0);
    const covers = Math.abs(width - sw) < 0.5 && Math.abs(height - sh) < 0.5;
    if (!covers && width > 0 && height > 0) {
      elements.push({ id: typeof node.AXUniqueId === "string" ? node.AXUniqueId : path, label: typeof node.AXLabel === "string" ? node.AXLabel : "", role: typeof node.type === "string" ? node.type : "",
        x: numberOr(frame.x, 0) / sw, y: numberOr(frame.y, 0) / sh, width: width / sw, height: height / sh });
    }
    (Array.isArray(node.children) ? node.children : []).forEach((child, i) => visit(child, `${path}.${i}`));
  };
  roots.forEach((root, i) => visit(root, String(i)));
  return elements;
}

/** fetchDeviceAxTree's payload handling, per platform. */
export function parseAxPayload(platform: DevicePlatform, payload: unknown): DeviceAxTree {
  if (platform === "ios") {
    if (!Array.isArray(payload)) return { elements: [], errors: [isRecord(payload) && typeof payload.error === "string" ? payload.error : "Unexpected accessibility payload."] };
    return { elements: flattenIosAxTree(payload), errors: [] };
  }
  if (!isRecord(payload) || !Array.isArray(payload.nodes)) return { elements: [], errors: [isRecord(payload) && typeof payload.error === "string" ? payload.error : "Unexpected accessibility payload."] };
  const nodes = payload.nodes.filter((n): n is Record<string, unknown> => isRecord(n) && isRecord(n.bounds));
  const root = nodes[0]?.bounds as Record<string, unknown> | undefined;
  const sw = Math.max(1, numberOr(root?.right, 1)); const sh = Math.max(1, numberOr(root?.bottom, 1));
  const elements = nodes.slice(1).flatMap((node): DeviceAxElement[] => {
    const b = node.bounds as Record<string, unknown>;
    const left = numberOr(b.left, 0); const top = numberOr(b.top, 0);
    const width = (numberOr(b.right, left) - left) / sw; const height = (numberOr(b.bottom, top) - top) / sh;
    const label = (typeof node.text === "string" ? node.text : "") || (typeof node.contentDescription === "string" ? node.contentDescription : "");
    if (width >= 0.95 && height >= 0.9) return [];
    if (!label && node.clickable !== true) return [];
    const className = typeof node.className === "string" ? node.className : "";
    return [{ id: String(node.id ?? ""), label, role: className.split(".").at(-1) ?? "", x: left / sw, y: top / sh, width, height }];
  });
  return { elements, errors: [] };
}

export async function fetchDeviceAxTree(t: DeviceHubTarget, fetcher: typeof fetch = fetch): Promise<DeviceAxTree> {
  const response = await fetcher(axUrl(t), { cache: "no-store" } as RequestInit);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return parseAxPayload(t.platform, await response.json());
}

export function toEventLogEntry(raw: unknown): DeviceEventLogEntry | null {
  if (!isRecord(raw) || typeof raw.id !== "number") return null;
  return { id: raw.id, timestamp: typeof raw.timestamp === "string" ? raw.timestamp : "", kind: typeof raw.kind === "string" ? raw.kind : "",
    summary: typeof raw.summary === "string" ? raw.summary : typeof raw.msg === "string" ? raw.msg : "" };
}

/** A reset batch replaces the log; the newest entries are kept up to the limit. */
export function appendDeviceEventLog(current: readonly DeviceEventLogEntry[], incoming: readonly DeviceEventLogEntry[], reset: boolean): DeviceEventLogEntry[] {
  const merged = reset ? [...incoming] : [...current, ...incoming];
  return merged.length > DEVICE_EVENT_LOG_LIMIT ? merged.slice(-DEVICE_EVENT_LOG_LIMIT) : merged;
}

/** One event-log SSE message: a batch (`events`, resets) or one `event`. */
export function readEventLogMessage(data: unknown): { entries: DeviceEventLogEntry[]; reset: boolean } | null {
  if (!isRecord(data)) return null;
  if (Array.isArray(data.events)) return { entries: data.events.flatMap((raw) => toEventLogEntry(raw) ?? []), reset: true };
  const entry = toEventLogEntry(data.event);
  return entry ? { entries: [entry], reset: false } : null;
}

/** One /appstate SSE message: the foreground app, null for none, undefined when it is not one. */
export function readForegroundMessage(data: unknown): { id: string } | null | undefined {
  if (!isRecord(data)) return undefined;
  if (data.bundleId === null || data.bundleId === "") return null;
  return typeof data.bundleId === "string" ? { id: data.bundleId } : undefined;
}

/** captureDeviceScreenshot (client-runtime/device/screenshot.ts): the hub's PNG of the device's screen. */
export async function captureDeviceScreenshot(t: DeviceHubTarget, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  const response = await fetcher(hubUrl(t, "/api/screenshot", { device: t.deviceId }), { method: "POST", signal: AbortSignal.timeout(20_000) } as RequestInit);
  if (!response.ok) throw new Error(`Screenshot capture failed (${response.status}). Try again.`);
  const image = new Uint8Array(await response.arrayBuffer());
  if (!image.length) throw new Error("The device returned an empty screenshot. Try again.");
  return image;
}

/** DeviceWorkspace's download name: the device name with anything but letters, digits and dashes as dashes. */
export function deviceScreenshotFileName(deviceName: string, now: number): string {
  return `${deviceName.replace(/[^a-z0-9-]/gi, "-")}-${now}.png`;
}
