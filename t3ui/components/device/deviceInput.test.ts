import { expect, test } from "nsh/test";
import { DEVICE_INPUT_SCRIPT, deviceInputScript, installDeviceInput, inputSocketUrl } from "./deviceInput";
import { streamPage } from "./deviceStream";

// Runs the page script (the same text the stream WebView runs) against a fake window, document, image and WebSocket.
function harness(cfg: { platform: "ios" | "android"; avcc: boolean }) {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const on = (target: string) => (type: string, fn: (e: any) => void) => { (listeners[`${target}:${type}`] ??= []).push(fn); };
  const fire = (target: string, type: string, e: any) => { for (const fn of listeners[`${target}:${type}`] ?? []) fn(e); };
  const posted: any[] = [];
  const sent: any[] = [];
  const sockets: any[] = [];
  class FakeSocket {
    readyState = 0; binaryType = ""; onopen: any; onmessage: any; onclose: any; onerror: any;
    constructor(public url: string) { sockets.push(this); }
    send(p: any) { sent.push(typeof p === "string" ? JSON.parse(p) : { tag: p[0], ...JSON.parse(new TextDecoder().decode(p.subarray(1))) }); }
    close() {}
  }
  const img = {
    naturalWidth: 100, naturalHeight: 200,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }),
    addEventListener: on("img"), setPointerCapture() {},
  };
  const win = { nsh: { postMessage: (m: string) => posted.push(JSON.parse(m)) }, addEventListener: on("win") };
  const doc = { getElementById: () => img, addEventListener: on("doc") };
  installDeviceInput({ url: "ws://hub/x", ...cfg }, { window: win, document: doc, WebSocket: FakeSocket, setTimeout: () => 0 });
  const frame = (tag: number, body: unknown) => { const j = new TextEncoder().encode(JSON.stringify(body)); const o = new Uint8Array(1 + j.length); o[0] = tag; o.set(j, 1); return o.buffer; };
  return { posted, sent, sockets, fire, frame };
}

test("the input socket is the vendor's, as ws, with the hub query", () => {
  const access = { httpBase: "https://h/api/device-hub", query: { hostId: "local", wsTicket: "T" } };
  expect(inputSocketUrl(access, { platform: "ios", deviceId: "A B" })).toBe("wss://h/api/device-hub/vendor/serve-sim/helper/ws?device=A%20B&hostId=local&wsTicket=T");
  expect(inputSocketUrl(access, { platform: "android", deviceId: "emu" })).toBe("wss://h/api/device-hub/vendor/serve-emu/ws?device=emu&video=0&hostId=local&wsTicket=T");
  const page = streamPage("http://h/s", deviceInputScript({ url: "ws://x</script>", platform: "ios", avcc: true }));
  expect(page).toContain("<script>");
  expect(page.includes("ws://x</script>")).toBe(false);
  // The page runs the serialized function itself: no helper from outside it.
  expect(DEVICE_INPUT_SCRIPT.startsWith("function installDeviceInput(cfg, env)")).toBe(true);
  expect(/__name|__require|_interop/.test(DEVICE_INPUT_SCRIPT)).toBe(false);
});

test("iOS input waits for admission, then sends tagged touch, buttons, keys and rotation", () => {
  const h = harness({ platform: "ios", avcc: true });
  const ws = h.sockets[0];
  ws.readyState = 1; ws.onopen?.();
  h.fire("img", "pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 100, preventDefault() {} });
  expect(h.sent.length).toBe(0); // not admitted yet
  ws.onmessage({ data: h.frame(0x83, {}) });
  expect(h.posted.at(-1)).toEqual({ t3: "input", connected: true, detail: "" });
  ws.onmessage({ data: h.frame(0x82, { width: 100, height: 200, orientation: "portrait" }) });
  // The image is 200x200 with a 100x200 picture centred: x 50..150, so (100,100) is the middle.
  h.fire("img", "pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 100, preventDefault() {} });
  h.fire("img", "pointerup", { pointerId: 1, clientX: 150, clientY: 200, type: "pointerup" });
  expect(h.sent[0]).toEqual({ tag: 3, type: "begin", x: 0.5, y: 0.5 });
  expect(h.sent[1]).toEqual({ tag: 3, type: "end", x: 1, y: 1 });
  h.fire("win", "message", { data: JSON.stringify({ t3device: "button", button: "home" }) });
  h.fire("win", "message", { data: JSON.stringify({ t3device: "button", button: "recents" }) });
  h.fire("win", "message", { data: JSON.stringify({ t3device: "rotate" }) });
  h.fire("doc", "keydown", { code: "KeyA", key: "a", preventDefault() {} });
  h.fire("doc", "keyup", { code: "KeyA", key: "a" });
  expect(h.sent.slice(2)).toEqual([
    { tag: 4, button: "home" }, { tag: 4, button: "app_switcher" }, { tag: 7, orientation: "landscape_left" },
    { tag: 6, type: "down", usage: 4 }, { tag: 6, type: "up", usage: 4 },
  ]);
  ws.onmessage({ data: h.frame(0x82, { width: 100, height: 200, orientation: "portrait", inputUnavailable: true }) });
  expect(h.posted.at(-1)).toEqual({ t3: "input", connected: false, detail: "Simulator input is unavailable" });
});

test("Android input sends serve-emu JSON once the socket opens", () => {
  const h = harness({ platform: "android", avcc: false });
  const ws = h.sockets[0];
  ws.readyState = 1; ws.onopen();
  expect(h.posted.at(-1)).toEqual({ t3: "input", connected: true, detail: "" });
  h.fire("img", "pointerdown", { button: 0, pointerId: 2, clientX: 50, clientY: 0, preventDefault() {} });
  h.fire("win", "message", { data: JSON.stringify({ t3device: "button", button: "back" }) });
  h.fire("win", "message", { data: JSON.stringify({ t3device: "button", button: "recents" }) });
  h.fire("doc", "keydown", { code: "Escape", key: "Escape", preventDefault() {} });
  h.fire("doc", "keydown", { code: "Enter", key: "Enter", preventDefault() {} });
  h.fire("doc", "keydown", { code: "KeyQ", key: "q", preventDefault() {} });
  h.fire("doc", "paste", { clipboardData: { getData: () => "hi" }, preventDefault() {} });
  expect(h.sent).toEqual([
    { type: "touch", action: "down", x: 0, y: 0 }, { type: "back" }, { type: "recents" },
    { type: "back" }, { type: "key", keycode: 66 }, { type: "text", text: "q" }, { type: "text", text: "hi" },
  ]);
});

test("the page opens and closes hub EventSources by name and posts their messages; AX frames draw over the picture", () => {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const posted: any[] = []; const sources: any[] = [];
  class FakeEventSource { closed = false; l: ((e: any) => void)[] = []; constructor(public url: string) { sources.push(this); } addEventListener(_t: string, fn: any) { this.l.push(fn); } close() { this.closed = true; } }
  const made: any[] = [];
  const el = () => { const node: any = { style: {}, children: [] as any[], appendChild(c: any) { node.children.push(c); }, set innerHTML(_v: string) { node.children = []; } }; made.push(node); return node; };
  const img = { naturalWidth: 100, naturalHeight: 100, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }), addEventListener() {} };
  const doc = { getElementById: () => img, addEventListener() {}, createElement: el, body: el() };
  const win = { nsh: { postMessage: (m: string) => posted.push(JSON.parse(m)) }, addEventListener: (t: string, fn: any) => { (listeners[t] ??= []).push(fn); } };
  installDeviceInput({ url: "ws://x", platform: "ios", avcc: true }, { window: win, document: doc, WebSocket: class { addEventListener() {} send() {} close() {} }, setTimeout: () => 0, EventSource: FakeEventSource });
  const send = (m: unknown) => { for (const fn of listeners.message ?? []) fn({ data: JSON.stringify(m) }); };
  send({ t3device: "sse", name: "eventlog", url: "http://h/log" });
  sources[0].l[0]({ data: JSON.stringify({ event: { id: 1, msg: "tap" } }) });
  expect(posted.at(-1)).toEqual({ t3: "sse", name: "eventlog", data: { event: { id: 1, msg: "tap" } } });
  send({ t3device: "sse", name: "eventlog", url: null });
  expect(sources[0].closed).toBe(true);
  send({ t3device: "ax", elements: [{ label: "OK", x: 0.5, y: 0.5, width: 0.1, height: 0.1 }] });
  const box = made.find((n) => n.style.cssText?.includes("left:50px"));
  expect(box !== undefined).toBe(true);
});
