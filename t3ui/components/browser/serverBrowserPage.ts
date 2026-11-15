// @ts-nocheck -- serverBrowserStream.ts: this function runs inside a WebView page (serialized with toString), so it is
// plain JavaScript that reads nothing outside itself. It is the port of client-runtime/preview/serverBrowserStream.ts
// (createPreviewStreamClient + createPreviewFramePainter) and the canvas input of browser/ServerBrowserSurface.tsx
// (handlePointer, wheel, handleKey, paste, resize). The headless test runs it with fakes.
//
// cfg: { url, threadId, tabId } ; env: { window, document, WebSocket, setTimeout, clearTimeout, createImageBitmap, Blob, ResizeObserver }
// Posts { t3: "sb", ... } to the host (window.nsh.postMessage); takes { t3sb: "send", input } and { t3sb: "stop" } messages.
export function installServerBrowser(cfg, env) {
  var W = env.window, D = env.document, WebSocket = env.WebSocket, setTimeout = env.setTimeout, clearTimeout = env.clearTimeout;
  var post = function (m) { m.t3 = "sb"; try { W.nsh && W.nsh.postMessage(JSON.stringify(m)); } catch (e) {} };
  var canvas = D.getElementById("c"), ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;
  var stopped = false, socket = null, retry = null, failures = 0, control = null, viewport = null, hasFrame = false;
  var followSize = cfg.followSize !== false;
  var cap = null, size = null, buttons = 0, clicks = { left: 0, middle: 0, right: 0, none: 0 }, lastClick = null;
  var ACK = JSON.stringify({ type: "ack" });
  var maxBytes = function (v) { return String(Math.max(1, Math.round(v))); };
  var urlFor = function () {
    var sep = cfg.url.indexOf("?") >= 0 ? "&" : "?";
    return cfg.url + sep + "threadId=" + encodeURIComponent(cfg.threadId) + "&tabId=" + encodeURIComponent(cfg.tabId) + "&maxWidth=" + maxBytes(cap.width) + "&maxHeight=" + maxBytes(cap.height);
  };
  // createPreviewFramePainter: one decode at a time, the latest waiting frame kept.
  var decoding = false, waiting = null;
  var draw = function (jpeg) {
    decoding = true;
    Promise.resolve(env.createImageBitmap(new env.Blob([jpeg], { type: "image/jpeg" }))).then(function (bitmap) {
      if (stopped || !ctx) { bitmap.close && bitmap.close(); return; }
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height; }
      ctx.drawImage(bitmap, 0, 0); bitmap.close && bitmap.close();
      if (!hasFrame) { hasFrame = true; post({ type: "firstFrame" }); }
    }).catch(function () {}).then(function () { decoding = false; var next = waiting; waiting = null; if (next && !stopped) draw(next); });
  };
  var paint = function (jpeg) { if (stopped) return; if (decoding) waiting = jpeg; else draw(jpeg); };
  var send = function (input) {
    if (!socket || socket.readyState !== 1) return false;
    if (!control || !control.canOperate) return false;
    if (input.type !== "takeControl" && control.controller !== "you") return false;
    socket.send(JSON.stringify(input));
    return true;
  };
  var connect = function () {
    if (stopped || !cap) return;
    var ws = new WebSocket(urlFor());
    ws.binaryType = "arraybuffer";
    socket = ws;
    var opened = false;
    ws.addEventListener("open", function () { if (socket !== ws) return; opened = true; post({ type: "connected", connected: true }); });
    ws.addEventListener("message", function (event) {
      if (socket !== ws) return;
      if (event.data instanceof ArrayBuffer) { failures = 0; ws.send(ACK); paint(event.data); return; }
      if (typeof event.data !== "string") return;
      var m; try { m = JSON.parse(event.data); } catch (e) { return; }
      if (!m || typeof m !== "object") return;
      if (m.type === "viewport" && typeof m.width === "number" && typeof m.height === "number") { failures = 0; viewport = { width: m.width, height: m.height }; post({ type: "viewport", width: m.width, height: m.height }); }
      else if (m.type === "control" && typeof m.canOperate === "boolean" && typeof m.generation === "number" && ["agent", "you", "another-viewer", "unclaimed"].indexOf(m.controller) >= 0) {
        var previous = control;
        control = { canOperate: m.canOperate, controller: m.controller, generation: m.generation, dialog: m.dialog && typeof m.dialog.message === "string" ? { type: String(m.dialog.type), message: m.dialog.message, defaultValue: String(m.dialog.defaultValue || "") } : null };
        post({ type: "control", control: control });
        if (cur && cur.style && you()) cur.style.display = "none";
        if (followSize && control.controller === "you" && (!previous || previous.controller !== "you") && size) send({ type: "resize", width: size.width, height: size.height });
      }
      else if (m.type === "pointer" && (m.phase === "move" || m.phase === "click") && typeof m.x === "number" && typeof m.y === "number") { post({ type: "pointer", phase: m.phase, x: m.x, y: m.y, sequence: m.sequence }); placeCursor(m); }
      else if (m.type === "popup" && typeof m.tabId === "string") post({ type: "popup", tabId: m.tabId });
      else if (m.type === "clipboard" && typeof m.text === "string") post({ type: "clipboard", text: m.text });
      else if (m.type === "download" && typeof m.id === "string" && typeof m.fileName === "string") post({ type: "download", id: m.id, fileName: m.fileName, sizeBytes: m.sizeBytes });
    });
    ws.addEventListener("close", function (event) {
      if (socket !== ws) return;
      socket = null; control = null;
      post({ type: "closed", code: event.code, opened: opened });
      if (opened) post({ type: "connected", connected: false });
      if (stopped) return;
      if (event.code === 4404) { stopped = true; post({ type: "gone" }); return; }
      if (event.code === 4503) { stopped = true; post({ type: "hostSetup", reason: event.reason || "" }); return; }
      if (event.code === 1008 || event.code === 4401 || (!opened && event.code === 1006)) { stopped = true; post({ type: "unauthorized" }); return; }
      retry = setTimeout(connect, Math.min(500 * Math.pow(2, failures++), 10000));
    });
    ws.addEventListener("error", function () { try { ws.close(); } catch (e) {} });
  };
  // pagePoint: the canvas is object-fit contain; page CSS px of the remote viewport.
  var pagePoint = function (clientX, clientY, clamp) {
    if (!viewport || !canvas.width || !canvas.height) return null;
    var r = canvas.getBoundingClientRect(), fit = Math.min(r.width / canvas.width, r.height / canvas.height);
    var w = canvas.width * fit, h = canvas.height * fit, left = r.left + (r.width - w) / 2, top = r.top + (r.height - h) / 2;
    var x = (clientX - left) / w, y = (clientY - top) / h;
    if (!clamp && (x < 0 || y < 0 || x > 1 || y > 1)) return null;
    x = Math.min(1, Math.max(0, x)); y = Math.min(1, Math.max(0, y));
    return { x: x * viewport.width, y: y * viewport.height, scale: viewport.width / w };
  };
  var mods = function (e) { return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0); };
  var buttonOf = function (b) { return b === 0 ? "left" : b === 1 ? "middle" : b === 2 ? "right" : "none"; };
  var pressedOf = function (b) { return b & 1 ? "left" : b & 2 ? "right" : b & 4 ? "middle" : "none"; };
  var countClick = function (button, x, y, time) {
    var l = lastClick, count = l && l.button === button && time - l.time < 500 && Math.hypot(x - l.x, y - l.y) < 4 ? Math.min(l.count + 1, 3) : 1;
    lastClick = { button: button, time: time, x: x, y: y, count: count }; return count;
  };
  var you = function () { return control && control.controller === "you"; };
  // AgentCursorMark (AgentBrowserCursor.tsx:62-99, placeAgentCursor in ServerBrowserSurface.tsx:941-958): the agent's
  // pointer drawn over the contain-fitted frame, opacity 1 for 700 ms after each move or click then 0.35, a ping on a
  // click, hidden while this viewer has control.
  var cur = D.getElementById("cur"), ping = D.getElementById("ping"), curTimer = null;
  var placeCursor = function (p) {
    if (!cur || !cur.style || !canvas || !viewport || canvas.width < 1 || canvas.height < 1) return;
    var r = canvas.getBoundingClientRect(), fit = Math.min(r.width / canvas.width, r.height / canvas.height);
    var w = canvas.width * fit, h = canvas.height * fit;
    var left = (r.width - w) / 2 + (p.x * w) / viewport.width, top = (r.height - h) / 2 + (p.y * h) / viewport.height;
    cur.style.transform = "translate3d(" + left + "px," + top + "px,0)";
    cur.style.display = you() ? "none" : "block";
    cur.style.opacity = "1";
    if (curTimer) clearTimeout(curTimer);
    // agentBrowserCursorOpacity (agentBrowserCursorLogic.ts:3-6): 1 while active, then 0.18 under a human's control
    // (the reference's desktop overlay; a server tab hides the mark while this viewer has control) or 0.35.
    curTimer = setTimeout(function () { cur.style.opacity = control && control.controller === "human" ? "0.18" : "0.35"; }, 700);
    if (ping && ping.style) { ping.style.display = p.phase === "click" ? "block" : "none"; if (p.phase === "click") { ping.style.animation = "none"; void ping.offsetWidth; ping.style.animation = ""; } }
  };
  var pointer = function (event) {
    if (!you()) return;
    // Thumb buttons: Back (3) and Forward (4) go to the tab's history on release (ServerBrowserSurface.tsx:636-647).
    if (event.button === 3 || event.button === 4) { if (event.type === "pointerup") { if (event.preventDefault) event.preventDefault(); send({ type: "history", delta: event.button === 3 ? -1 : 1 }); } return; }
    var type = event.type, cancelled = type === "pointercancel", previous = buttons;
    if ((cancelled || type === "pointerup") && previous === 0) return;
    if (cancelled || type === "pointerup") buttons = cancelled ? 0 : event.buttons & 7;
    var p = pagePoint(event.clientX, event.clientY, type !== "pointerdown");
    if (!p) return;
    var at = { x: p.x, y: p.y, modifiers: mods(event) };
    var mouse = function (action, button, held) {
      if (action === "down") clicks[button] = countClick(button, event.clientX, event.clientY, event.timeStamp || 0);
      send({ type: "mouse", action: action, x: at.x, y: at.y, modifiers: at.modifiers, button: button, buttons: held, clickCount: clicks[button] });
    };
    if (type === "pointerdown") { try { canvas.setPointerCapture(event.pointerId); } catch (e) {} if (inp && inp.focus) try { inp.focus({ preventScroll: true }); } catch (e) {} buttons = event.buttons & 7; mouse("down", buttonOf(event.button), event.buttons); }
    else if (type === "pointerup") mouse("up", buttonOf(event.button), event.buttons);
    else {
      var next = cancelled ? 0 : event.buttons & 7, changed = previous ^ next;
      if (previous !== 0 && changed !== 0) { var held = previous; [1, 2, 4].forEach(function (bit) { if (!(changed & bit)) return; held ^= bit; mouse(next & bit ? "down" : "up", pressedOf(bit), held); }); buttons = next; }
      if (cancelled) return;
      send({ type: "mouse", action: "move", x: at.x, y: at.y, modifiers: at.modifiers, button: pressedOf(event.buttons), buttons: event.buttons, clickCount: 0 });
    }
  };
  if (canvas) {
    ["pointerdown", "pointermove", "pointerup", "pointercancel"].forEach(function (t) { canvas.addEventListener(t, pointer); });
    canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    canvas.addEventListener("wheel", function (event) {
      var p = pagePoint(event.clientX, event.clientY, false);
      if (!p) return;
      event.preventDefault();
      var unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (viewport ? viewport.height : 0) : 1;
      if (you()) send({ type: "wheel", x: p.x, y: p.y, deltaX: event.deltaX * unit, deltaY: event.deltaY * unit, modifiers: mods(event) });
    }, { passive: false });
  }
  // The hidden textarea of ServerBrowserSurface.tsx:650-741, 796-824: it takes the keyboard while this viewer has
  // control, so IME composition, the Edit menu's Copy and Cut, and Shift+Escape (leave the page) work.
  var inp = D.getElementById("inp"), keySent = false, SENTINEL = "\u200b", CTRL = 2;
  var BACKSPACE = { key: "Backspace", code: "Backspace", keyCode: 8 }, DELETE = { key: "Delete", code: "Delete", keyCode: 46 };
  var COPY = { key: "c", code: "KeyC", keyCode: 67 }, CUT = { key: "x", code: "KeyX", keyCode: 88 };
  var resetInput = function () { keySent = false; if (!inp) return; inp.value = SENTINEL; try { inp.setSelectionRange(1, 1); } catch (e) {} };
  var press = function (k, modifiers) {
    send({ type: "key", action: "down", key: k.key, code: k.code, keyCode: k.keyCode, modifiers: modifiers || 0 });
    send({ type: "key", action: "up", key: k.key, code: k.code, keyCode: k.keyCode, modifiers: modifiers || 0 });
  };
  var key = function (action, event) {
    if (!you()) return;
    keySent = false;
    if (event.isComposing || event.keyCode === 229 || event.key === "Process" || event.key === "Unidentified") return;
    if (event.key === "Escape" && event.shiftKey) {
      if (event.preventDefault) event.preventDefault();
      if (event.stopPropagation) event.stopPropagation();
      if (action === "down" && inp && inp.blur) inp.blur();
      return;
    }
    var shortcut = event.ctrlKey || event.metaKey;
    if (shortcut && String(event.key).toLowerCase() === "v") return;
    if (event.shiftKey && event.key === "Insert") return;
    var text = shortcut ? undefined : Array.from(event.key).length === 1 ? event.key : event.key === "Enter" ? "\r" : undefined;
    var input = { type: "key", action: action, key: event.key, code: event.code, keyCode: event.keyCode, modifiers: mods(event) };
    if (action === "down" && text !== undefined) input.text = text;
    send(input);
    keySent = action === "down" && !shortcut && (text !== undefined || event.key === "Backspace" || event.key === "Delete");
    // The key copies or cuts in the page, so the WebView's own copy or cut must not repeat it.
    if (event.ctrlKey !== event.metaKey && !event.altKey && !event.shiftKey && (String(event.key).toLowerCase() === "c" || String(event.key).toLowerCase() === "x") && event.preventDefault) event.preventDefault();
    if (!shortcut) event.preventDefault();
  };
  if (inp && inp.addEventListener) {
    inp.addEventListener("focus", resetInput);
    inp.addEventListener("input", function (event) {
      if (event.isComposing) return;
      var inputType = event.inputType || "";
      if (keySent) keySent = false;
      else if (inputType === "deleteContentBackward") { if (you()) press(BACKSPACE); }
      else if (inputType === "deleteContentForward") { if (you()) press(DELETE); }
      else { var t = String(inp.value || "").replace(/^\u200b/, ""); if (t && you()) send({ type: "text", text: t }); }
      resetInput();
    });
    inp.addEventListener("compositionend", function (event) {
      var t = String(event.data || "").replace(/^\u200b/, "");
      if (t && you()) send({ type: "text", text: t });
      resetInput();
    });
  }
  // Edit menu Copy and Cut fire no key, so the shortcut the server copies on is sent; the sentinel stays off the clipboard.
  var clip = function (k) { return function (event) { if (event.preventDefault) event.preventDefault(); if (you()) press(k, CTRL); }; };
  D.addEventListener("copy", clip(COPY));
  D.addEventListener("cut", clip(CUT));
  D.addEventListener("keydown", function (e) { key("down", e); });
  D.addEventListener("keyup", function (e) { key("up", e); });
  D.addEventListener("paste", function (e) { e.preventDefault(); var t = e.clipboardData ? e.clipboardData.getData("text/plain") : ""; if (t && you()) send({ type: "text", text: t }); });
  W.addEventListener("message", function (ev) {
    var m; try { m = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data; } catch (e) { return; }
    if (!m || !m.t3sb) return;
    if (m.t3sb === "send") post({ type: "sent", ok: send(m.input), inputType: m.input && m.input.type });
    else if (m.t3sb === "followSize") { followSize = m.value !== false; if (followSize && size && you()) send({ type: "resize", width: size.width, height: size.height }); }
    else if (m.t3sb === "stop") { stopped = true; if (retry) clearTimeout(retry); if (socket) try { socket.close(); } catch (e) {} }
  });
  // The container's size: resizes go to the stream (followSize), and the first size sets the frame cap and connects.
  var measure = function () {
    var r = canvas ? canvas.getBoundingClientRect() : { width: 0, height: 0 };
    if (r.width < 1 || r.height < 1) return;
    var next = { width: Math.round(r.width), height: Math.round(r.height) };
    if (size && size.width === next.width && size.height === next.height) return;
    size = next;
    if (followSize && you()) send({ type: "resize", width: size.width, height: size.height });
    var ratio = W.devicePixelRatio || 1, want = { width: Math.round(size.width * ratio), height: Math.round(size.height * ratio) };
    if (!cap) { cap = want; connect(); }
  };
  if (env.ResizeObserver && canvas) new env.ResizeObserver(measure).observe(canvas);
  measure();
  post({ type: "started", size: size, hasCanvas: !!canvas });
  W.addEventListener("pagehide", function () { stopped = true; if (socket) try { socket.close(); } catch (e) {} });
}
