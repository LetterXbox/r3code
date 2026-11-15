import { expect, test } from "nsh/test";
import { installServerBrowser, previewPdfAssetUrl, previewStreamControlLabel, previewStreamDownloadUrl, previewStreamSocketUrl, serverBrowserPage, SERVER_BROWSER_SCRIPT } from "./serverBrowserStream";

function harness(followSize = true) {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const on = (t: string) => (type: string, fn: (e: any) => void) => { (listeners[`${t}:${type}`] ??= []).push(fn); };
  const fire = (t: string, type: string, e: any) => { for (const fn of listeners[`${t}:${type}`] ?? []) fn(e); };
  const posted: any[] = []; const sent: any[] = []; const sockets: any[] = [];
  class FakeSocket { readyState = 0; binaryType = ""; l: Record<string, ((e: any) => void)[]> = {};
    constructor(public url: string) { sockets.push(this); }
    addEventListener(type: string, fn: (e: any) => void) { (this.l[type] ??= []).push(fn); }
    emit(type: string, e: any) { for (const fn of this.l[type] ?? []) fn(e); }
    send(p: string) { sent.push(JSON.parse(p)); } close() {} }
  const canvas = { width: 800, height: 600, getContext: () => ({ drawImage() {} }), getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }), addEventListener: on("canvas"), setPointerCapture() {} };
  const win = { nsh: { postMessage: (m: string) => posted.push(JSON.parse(m)) }, addEventListener: on("win"), devicePixelRatio: 2 };
  const inp = { value: "", focused: 0, blurred: 0, setSelectionRange() {}, focus() { this.focused += 1; }, blur() { this.blurred += 1; }, addEventListener: on("inp") };
  const doc = { getElementById: (id: string) => (id === "inp" ? inp : canvas), addEventListener: on("doc") };
  installServerBrowser({ url: "ws://h/api/preview-stream/ws?wsTicket=T", threadId: "t1", tabId: "tab-1", followSize },
    { window: win, document: doc, WebSocket: FakeSocket, setTimeout: () => 0, clearTimeout() {}, createImageBitmap: async () => ({ width: 800, height: 600, close() {} }), Blob: class {}, ResizeObserver: undefined });
  return { posted, sent, sockets, fire, inp };
}

test("floating preview preserves the remote viewport until returned to the panel", () => {
  const h = harness(false);
  const ws = h.sockets[0]; ws.readyState = 1; ws.emit("open", {});
  ws.emit("message", { data: JSON.stringify({ type: "control", canOperate: true, controller: "you", generation: 1, dialog: null }) });
  expect(h.sent.filter((message) => message.type === "resize")).toEqual([]);
  h.fire("win", "message", { data: JSON.stringify({ t3sb: "followSize", value: true }) });
  expect(h.sent.filter((message) => message.type === "resize")).toEqual([{ type: "resize", width: 400, height: 300 }]);
});

test("the stream URL carries the thread, tab, frame cap and ticket", () => {
  expect(previewStreamSocketUrl("http://127.0.0.1:3773/ws", { wsTicket: "T" })).toBe("ws://127.0.0.1:3773/api/preview-stream/ws?wsTicket=T");
  const h = harness();
  expect(h.sockets[0].url).toBe("ws://h/api/preview-stream/ws?wsTicket=T&threadId=t1&tabId=tab-1&maxWidth=800&maxHeight=600");
  expect(serverBrowserPage({ url: "ws://x</script>", threadId: "t", tabId: "b" }).includes("ws://x</script>")).toBe(false);
  // fm13: the agent cursor mark is in the page, coloured by the theme; a colour that is not a colour is refused.
  expect(serverBrowserPage({ url: "ws://x", threadId: "t", tabId: "b" }, { primary: "#123456", background: "#fff" }).includes('stroke="#123456"')).toBe(true);
  expect(serverBrowserPage({ url: "ws://x", threadId: "t", tabId: "b" }, { primary: "red;}</style>", background: "#fff" }).includes("</style>\"")).toBe(false);
  expect(/__name|__require/.test(SERVER_BROWSER_SCRIPT)).toBe(false);
  expect(previewStreamControlLabel(null)).toBe("Connecting...");
});

test("frames are acked, control is reported, and input goes only while this viewer has control", () => {
  const h = harness();
  const ws = h.sockets[0];
  ws.readyState = 1; ws.emit("open", {});
  ws.emit("message", { data: new ArrayBuffer(4) });
  expect(h.sent[0]).toEqual({ type: "ack" });
  ws.emit("message", { data: JSON.stringify({ type: "viewport", width: 1280, height: 960 }) });
  ws.emit("message", { data: JSON.stringify({ type: "control", canOperate: true, controller: "agent", generation: 1, dialog: null }) });
  expect(h.posted.find((m) => m.type === "control").control.controller).toBe("agent");
  h.fire("canvas", "pointerdown", { type: "pointerdown", button: 0, buttons: 1, clientX: 200, clientY: 150, pointerId: 1 });
  expect(h.sent.length).toBe(1); // the agent has control: no input
  h.fire("win", "message", { data: JSON.stringify({ t3sb: "send", input: { type: "takeControl" } }) });
  expect(h.sent.at(-1)).toEqual({ type: "takeControl" });
  ws.emit("message", { data: JSON.stringify({ type: "control", canOperate: true, controller: "you", generation: 2, dialog: null }) });
  h.fire("canvas", "pointerdown", { type: "pointerdown", button: 0, buttons: 1, clientX: 200, clientY: 150, pointerId: 1, timeStamp: 1 });
  h.fire("doc", "keydown", { key: "a", code: "KeyA", keyCode: 65, preventDefault() {} });
  const mouse = h.sent.find((m) => m.type === "mouse");
  expect(mouse).toEqual({ type: "mouse", action: "down", x: 640, y: 480, modifiers: 0, button: "left", buttons: 1, clickCount: 1 });
  expect(h.sent.at(-1)).toEqual({ type: "key", action: "down", key: "a", code: "KeyA", keyCode: 65, modifiers: 0, text: "a" });
  // fm13: thumb Back / Forward release becomes a history step; the press itself sends nothing.
  h.fire("canvas", "pointerdown", { type: "pointerdown", button: 3, buttons: 8, clientX: 1, clientY: 1, pointerId: 1 });
  h.fire("canvas", "pointerup", { type: "pointerup", button: 3, buttons: 0, clientX: 1, clientY: 1, pointerId: 1, preventDefault() {} });
  expect(h.sent.at(-1)).toEqual({ type: "history", delta: -1 });
  h.fire("canvas", "pointerup", { type: "pointerup", button: 4, buttons: 0, clientX: 1, clientY: 1, pointerId: 1, preventDefault() {} });
  expect(h.sent.at(-1)).toEqual({ type: "history", delta: 1 });
  // fm13: an agent pointer while the agent has control is posted up and placed over the fitted frame.
  ws.emit("message", { data: JSON.stringify({ type: "control", canOperate: true, controller: "agent", generation: 3, dialog: null }) });
  ws.emit("message", { data: JSON.stringify({ type: "pointer", phase: "click", x: 640, y: 480, sequence: 7 }) });
  expect(h.posted.at(-1)).toEqual({ t3: "sb", type: "pointer", phase: "click", x: 640, y: 480, sequence: 7 });
  // fm13: the page passes clipboard, download and popup messages up to the surface.
  ws.emit("message", { data: JSON.stringify({ type: "download", id: "d1", fileName: "a.csv", sizeBytes: 3 }) });
  expect(h.posted.at(-1)).toEqual({ t3: "sb", type: "download", id: "d1", fileName: "a.csv", sizeBytes: 3 });
  ws.emit("close", { code: 4404 });
  expect(h.posted.at(-1).type).toBe("gone");
});

test("fm13: a downloaded file's Save address is the stream's download route with the ticket", () => {
  expect(previewStreamDownloadUrl("http://127.0.0.1:3773/ws", { threadId: "t1", tabId: "b1" }, "d1", { wsTicket: "T" })).toBe("http://127.0.0.1:3773/api/preview-stream/download?threadId=t1&tabId=b1&id=d1&wsTicket=T");
});

test("fm13: a server tab on a signed PDF asset shows the document, a loopback asset through this connection", () => {
  expect(previewPdfAssetUrl("http://127.0.0.1:9999/api/assets/a/b.pdf?sig=1", "https://env.example:3773")).toBe("https://env.example:3773/api/assets/a/b.pdf?sig=1");
  expect(previewPdfAssetUrl("https://cdn.example/api/assets/x.pdf", "https://env.example:3773")).toBe("https://cdn.example/api/assets/x.pdf");
  expect(previewPdfAssetUrl("https://env.example:3773/api/assets/x.png", "https://env.example:3773")).toBeNull();
  expect(previewPdfAssetUrl("https://env.example:3773/docs/x.pdf", "https://env.example:3773")).toBeNull();
  expect(previewPdfAssetUrl("https://env.example:3773/api/assets/x.pdf", null)).toBeNull();
});

test("fm13: IME composition, Edit-menu copy and cut, and Shift+Escape go through the page's hidden textarea", () => {
  const h = harness();
  const ws = h.sockets[0];
  ws.readyState = 1; ws.emit("open", {});
  ws.emit("message", { data: JSON.stringify({ type: "viewport", width: 1280, height: 960 }) });
  ws.emit("message", { data: JSON.stringify({ type: "control", canOperate: true, controller: "you", generation: 1, dialog: null }) });
  h.fire("canvas", "pointerdown", { type: "pointerdown", button: 0, buttons: 1, clientX: 10, clientY: 10, pointerId: 1, timeStamp: 1 });
  expect(h.inp.focused).toBe(1);
  // A composing key sends nothing; the composition's result goes as text.
  const before = h.sent.length;
  h.fire("doc", "keydown", { key: "Process", keyCode: 229, isComposing: true, preventDefault() {} });
  expect(h.sent.length).toBe(before);
  h.fire("inp", "compositionend", { data: "\u65e5\u672c" });
  expect(h.sent.at(-1)).toEqual({ type: "text", text: "\u65e5\u672c" });
  // Text the textarea took without a key (an input method) goes as text; a backward delete as Backspace.
  h.inp.value = "\u200b\u00e9";
  h.fire("inp", "input", { inputType: "insertText" });
  expect(h.sent.at(-1)).toEqual({ type: "text", text: "\u00e9" });
  h.fire("inp", "input", { inputType: "deleteContentBackward" });
  expect(h.sent.slice(-2)).toEqual([{ type: "key", action: "down", key: "Backspace", code: "Backspace", keyCode: 8, modifiers: 0 }, { type: "key", action: "up", key: "Backspace", code: "Backspace", keyCode: 8, modifiers: 0 }]);
  // A typed key already sent is not sent again by the input it causes.
  h.fire("doc", "keydown", { key: "b", code: "KeyB", keyCode: 66, preventDefault() {} });
  const typed = h.sent.length;
  h.inp.value = "\u200bb";
  h.fire("inp", "input", { inputType: "insertText" });
  expect(h.sent.length).toBe(typed);
  // Edit menu Copy / Cut send Ctrl+C / Ctrl+X.
  let prevented = 0;
  h.fire("doc", "copy", { preventDefault() { prevented += 1; } });
  expect(h.sent.slice(-2)).toEqual([{ type: "key", action: "down", key: "c", code: "KeyC", keyCode: 67, modifiers: 2 }, { type: "key", action: "up", key: "c", code: "KeyC", keyCode: 67, modifiers: 2 }]);
  h.fire("doc", "cut", { preventDefault() { prevented += 1; } });
  expect(h.sent.at(-1)).toEqual({ type: "key", action: "up", key: "x", code: "KeyX", keyCode: 88, modifiers: 2 });
  expect(prevented).toBe(2);
  // Shift+Escape leaves the page and sends nothing.
  const sentBefore = h.sent.length;
  h.fire("doc", "keydown", { key: "Escape", shiftKey: true, preventDefault() {}, stopPropagation() {} });
  expect(h.inp.blurred).toBe(1);
  expect(h.sent.length).toBe(sentBefore);
});
