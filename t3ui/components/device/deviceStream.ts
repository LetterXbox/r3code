// How the Device panel reaches the video (client-runtime/device/stream.ts, hubAccess.ts, deviceHubApi.ts): the hub is the
// environment's HTTP origin plus `hubBasePath`; a bearer connection adds a media WebSocket ticket as `wsTicket`, and the device's
// MJPEG feed is `/vendor/serve-sim|serve-emu/helper/<id>/stream.mjpeg?hostId=..`. The reference prefers H.264 over WebCodecs and
// falls back to this MJPEG feed (`preferMjpeg` is set for native WebViews). Pure, so it is tested without a server.
import type { DevicePlatform } from "./deviceLogic";

export interface DeviceHubAccess { httpBase: string; query: Record<string, string> }

export function hubHttpBase(endpoint: string, hubBasePath: string): string | null {
  if (!URL.canParse(endpoint)) return null;
  const url = new URL(endpoint);
  url.protocol = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
  url.pathname = hubBasePath; url.search = ""; url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function withHubQuery(url: string, query: Record<string, string>): string {
  const entries = Object.entries(query);
  if (entries.length === 0) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${new URLSearchParams(entries).toString()}`;
}

/** The MJPEG feed of a device. Hosts that serve only serve-sim (Simlock) use its vendor path on both platforms. */
export function mjpegUrl(access: DeviceHubAccess, input: { platform: DevicePlatform; deviceId: string; serveSimOnly?: boolean }): string {
  const vendor = input.platform === "ios" || input.serveSimOnly ? "/vendor/serve-sim" : "/vendor/serve-emu";
  return withHubQuery(`${access.httpBase}${vendor}/helper/${encodeURIComponent(input.deviceId)}/stream.mjpeg`, access.query);
}

/** A page that shows the feed, filling its frame (the WebView hosts it as `html`). */
export function streamPage(url: string, inputScript?: string): string {
  // `inputScript` (deviceInput.ts) adds touch, key and button input over the hub's input socket, in this same page.
  const input = inputScript ? `<script>${inputScript}</script>` : "";
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;background:#000;overflow:hidden}img{width:100%;height:100%;object-fit:contain;display:block;user-select:none;-webkit-user-select:none;touch-action:none}</style><img id="v" draggable="false" src=${JSON.stringify(url)} onerror="window.nsh&&window.nsh.postMessage(JSON.stringify({t3:'stream',status:'error'}))" onload="window.nsh&&window.nsh.postMessage(JSON.stringify({t3:'stream',status:'streaming'}))">${input}`;
}

/** Mints the media ticket (`POST /api/auth/websocket-ticket/media`, bearer connections). */
export async function mintMediaTicket(endpoint: string, bearer: string, fetcher: typeof fetch = fetch): Promise<string> {
  const base = hubHttpBase(endpoint, "")!;
  const response = await fetcher(`${base}/api/auth/websocket-ticket/media`, { method: "POST", headers: { authorization: `Bearer ${bearer}` } });
  if (!response.ok) throw new Error(`Device video authorization failed (HTTP ${response.status})`);
  const body = (await response.json()) as { ticket?: unknown };
  if (typeof body.ticket !== "string" || !body.ticket) throw new Error("The environment returned no video ticket.");
  return body.ticket;
}
