// Device input (client-runtime/device/stream.ts createDeviceStreamClient: sendTouch, sendKey, sendText, pressButton, rotate,
// setOrientation; DeviceStreamView.tsx pointer and key handlers). The NSH runtime has no WebSocket outside a WebView page, so
// the input socket lives in the stream page itself (deviceStream.ts streamPage): this file is the page's script, as a string,
// plus the URL of the socket. The host drives buttons and rotation with `WebViewRef.postMessage(JSON.stringify(command))`.
//
// Protocol, as the reference sends it with MJPEG video (iOS, or any Simlock host = serve-sim "avcc"):
//   socket  `<hub>/vendor/serve-sim/helper/ws?device=<id>&<hub query>`, binary. Input counts only after a 0x83 frame
//           (input admitted) and while the last 0x82 screen config has no `inputUnavailable`.
//   touch   0x03 + {"type":"begin"|"move"|"end",x,y} (x, y normalized; remapped into the raw portrait framebuffer)
//   button  0x04 + {"button":"home"|"app_switcher"|"lock"|"back"(Android on serve-sim)}
//   key     0x06 + {"type":"down"|"up","usage":<HID usage>}
//   rotate  0x07 + {"orientation":<next of portrait, landscape_left, portrait_upside_down, landscape_right>}
// Android on serve-emu: `<hub>/vendor/serve-emu/ws?device=<id>&video=0&<hub query>`, text frames:
//   {"type":"touch","action":"down"|"move"|"up",x,y}, {"type":"home"|"back"|"recents"|"power"}, {"type":"key","keycode"},
//   {"type":"text","text"} (300-byte chunks, at most 64), Escape -> {"type":"back"}.
import { INSTALL_DEVICE_INPUT_SOURCE } from "./deviceInputPage.generated";
import { withHubQuery, type DeviceHubAccess } from "./deviceStream";
import type { DevicePlatform } from "./deviceLogic";
import { installDeviceInput } from "./deviceInputPage";

export { installDeviceInput };

export type DeviceHardwareButton = "home" | "back" | "recents" | "power" | "appSwitcher";
export type DevicePageCommand =
  | { t3device: "button"; button: DeviceHardwareButton }
  | { t3device: "rotate" }
  | { t3device: "orientation"; orientation: "portrait" | "landscape_left" | "portrait_upside_down" | "landscape_right" }
  /** Draws the accessibility frames over the picture (normalized boxes; empty clears). */
  | { t3device: "ax"; elements: { label: string; x: number; y: number; width: number; height: number }[] }
  /** Opens (url) or closes (null) the page's EventSource `name`; its messages come back as {t3:"sse",name,data}. */
  | { t3device: "sse"; name: string; url: string | null };

/** The input socket of a device (`wsUrl` in stream.ts): the hub's origin as ws(s), the vendor path, the hub query. */
export function inputSocketUrl(access: DeviceHubAccess, input: { platform: DevicePlatform; deviceId: string; serveSimOnly?: boolean }): string {
  const avcc = input.platform === "ios" || input.serveSimOnly === true;
  const wsBase = access.httpBase.replace(/^http/, "ws");
  const device = encodeURIComponent(input.deviceId);
  return withHubQuery(avcc ? `${wsBase}/vendor/serve-sim/helper/ws?device=${device}` : `${wsBase}/vendor/serve-emu/ws?device=${device}&video=0`, access.query);
}

/**
 * The page's input script. `cfg` is `{ url, platform, avcc }`. It wires pointer input on the `#v` image (its object-fit
 * box), keys and paste on the document, and `message` commands from the host; it posts `{t3:"input",connected,detail}`.
 * Kept as plain ES5-ish JavaScript: it runs in the WebView, and the headless test runs the same text with fakes.
 */
/** The page's script source: the text of `installDeviceInput` (deviceInputPage.generated.ts; the release build's bytecode has no
 * function source to serialize), so tests run the same code the page does. */
export const DEVICE_INPUT_SCRIPT = INSTALL_DEVICE_INPUT_SOURCE;

/** The script with its config, ready to put in a `<script>` (a `</script>` in a URL cannot end it early). */
export function deviceInputScript(cfg: { url: string; platform: DevicePlatform; avcc: boolean }): string {
  return `(${DEVICE_INPUT_SCRIPT})(${JSON.stringify(cfg).replace(/</g, "\\u003c")},{window:window,document:document,WebSocket:WebSocket,setTimeout:setTimeout.bind(window),setInterval:setInterval.bind(window),EventSource:window.EventSource});`;
}
