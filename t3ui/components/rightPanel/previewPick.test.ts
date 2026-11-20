import { expect, test } from "nsh/test";
import { annotationScreenshotFile, captureAnnotationScreenshot, installPreviewPick, previewAnnotationContextLabel, previewAnnotationContextRecord, previewPickScript, readPickMessage } from "./previewPick";

// A small DOM: enough for the annotation layer (shadow root, boxes, toolbar, editor, textarea, listeners).
class Node_ {
  children: Node_[] = []; parent: Node_ | null = null; style: Record<string, string> = {}; attrs: Record<string, string> = {}; listeners: Record<string, ((e: any) => void)[]> = {};
  className = ""; textContent = ""; value = ""; placeholder = ""; rows = 1; type = ""; title = ""; id = ""; outerHTML = ""; scrollHeight = 20;
  rect = { left: 0, top: 0, width: 0, height: 0 };
  classList = { add: (c: string) => { if (!this.className.split(" ").includes(c)) this.className = `${this.className} ${c}`.trim(); }, remove: (c: string) => { this.className = this.className.split(" ").filter((x) => x !== c).join(" "); } };
  constructor(public tagName: string) { this.style = new Proxy({} as Record<string, string>, {}); }
  get isConnected() { return this.parent !== null; }
  appendChild(c: Node_) { c.parent = this; this.children.push(c); return c; }
  append(...cs: Node_[]) { cs.forEach((c) => this.appendChild(c)); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  hasAttribute(k: string) { return k in this.attrs; }
  addEventListener(t: string, fn: (e: any) => void) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t: string, fn: (e: any) => void) { this.listeners[t] = (this.listeners[t] ?? []).filter((f) => f !== fn); }
  fire(t: string, e: any) { for (const fn of this.listeners[t] ?? []) fn({ target: this, preventDefault() {}, stopPropagation() {}, composedPath: () => [], ...e }); }
  closest(sel: string) { let n: Node_ | null = this; const attr = sel.slice(1, -1); while (n) { if (attr in n.attrs) return n; n = n.parent; } return null; }
  getBoundingClientRect() { const r = this.rect; return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top }; }
  attachShadow() { return this; }
  focus() {}
  find(pred: (n: Node_) => boolean): Node_ | null { if (pred(this)) return this; for (const c of this.children) { const f = c.find(pred); if (f) return f; } return null; }
}

function page() {
  const html = new Node_("HTML"); const body = new Node_("BODY"); html.appendChild(body);
  const button = new Node_("BUTTON"); button.id = "b"; button.outerHTML = '<button id="b">Press me</button>'; button.rect = { left: 100, top: 100, width: 80, height: 30 }; body.appendChild(button);
  const posted: any[] = [];
  const winListeners: Record<string, ((e: any) => void)[]> = {};
  const doc = { documentElement: html, body, title: "DevPrev Page", createElement: (t: string) => new Node_(t.toUpperCase()), elementsFromPoint: () => [button, body, html], querySelectorAll: () => [button] };
  const win = { location: { href: "http://localhost:5000/" }, innerWidth: 800, innerHeight: 600, nsh: { postMessage: (m: string) => posted.push(JSON.parse(m)) },
    addEventListener: (t: string, fn: any) => { (winListeners[t] ??= []).push(fn); }, removeEventListener: (t: string, fn: any) => { winListeners[t] = (winListeners[t] ?? []).filter((f) => f !== fn); }, setTimeout: (fn: () => void) => fn() };
  const fireWin = (t: string, e: any) => { for (const fn of [...(winListeners[t] ?? [])]) fn({ preventDefault() {}, stopPropagation() {}, composedPath: () => [], target: button, ...e }); };
  return { html, button, posted, doc, win, fireWin, winListeners };
}

test("a detached pick keeps its screenshot crop until the page scrolls", () => {
  for (const scrolled of [false, true]) {
    const p = page();
    installPreviewPick({ sendEnabled: false, theme: {} }, { window: p.win, document: p.doc });
    p.fireWin("pointerdown", { button: 0, clientX: 120, clientY: 110 });
    p.button.remove();
    p.button.rect = { left: 0, top: 0, width: 0, height: 0 };
    if (scrolled) p.fireWin("scroll", {});
    p.html.find((n) => n.className === "attach")!.fire("click", {});
    expect(p.posted[0].screenshotRect).toEqual(scrolled ? null : { x: 80, y: 80, width: 120, height: 70 });
  }
});

test("picking an element opens the comment editor; Enter attaches the annotation with its comment", () => {
  const p = page();
  installPreviewPick({ sendEnabled: false, theme: {} }, { window: p.win, document: p.doc });
  const editor = p.html.find((n) => n.className === "editor")!;
  expect(editor.style.display).toBe("none");
  const toolbar = p.html.find((n) => n.className === "bar")!;
  expect(toolbar.children.map((c) => c.textContent)).toEqual(["Select", "Region", "Draw", "Erase"]);
  p.fireWin("pointerdown", { button: 0, clientX: 120, clientY: 110 });
  expect(editor.style.display).toBe("flex");
  const comment = p.html.find((n) => n.tagName === "TEXTAREA")!;
  expect(comment.placeholder).toBe("Describe the change…");
  const label = p.html.find((n) => n.className === "label")!;
  expect(label.textContent).toBe("button#b");
  comment.value = "Make this button red";
  editor.fire("keydown", { target: comment, key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false });
  const message = readPickMessage(JSON.stringify(p.posted[0]));
  if (message === null || message === "cancelled") throw new Error("no annotation");
  expect(message.submission).toBe("attach");
  expect(message.annotation.comment).toBe("Make this button red");
  expect(message.annotation.elements[0]!.element.tagName).toBe("button");
  expect(message.annotation.pageTitle).toBe("DevPrev Page");
  // fm13: the crop is the target's box padded by 20 px (unionRects), clipped to the viewport.
  expect(message.screenshotRect).toEqual({ x: 80, y: 80, width: 120, height: 70 });
  // The layer is gone after submit.
  expect(p.html.find((n) => n.className === "editor")).toBeNull();
  const record = previewAnnotationContextRecord(message.annotation);
  expect(record.kind).toBe("preview-annotation");
  expect(record.label).toBe("Make this button red");
  expect(record.comment).toBe("Make this button red");
  expect(record.targetSummary).toBe("1 selected element");
});

test("Escape cancels; Cmd+Enter sends only when sending is allowed; the label falls back to the page title", () => {
  const p = page();
  installPreviewPick({ sendEnabled: false }, { window: p.win, document: p.doc });
  p.fireWin("keydown", { key: "Escape" });
  expect(readPickMessage(JSON.stringify(p.posted[0]))).toBe("cancelled");
  const q = page();
  installPreviewPick({ sendEnabled: true }, { window: q.win, document: q.doc });
  q.fireWin("pointerdown", { button: 0, clientX: 120, clientY: 110 });
  const editor = q.html.find((n) => n.className === "editor")!;
  const comment = q.html.find((n) => n.tagName === "TEXTAREA")!;
  editor.fire("keydown", { target: comment, key: "Enter", shiftKey: false, metaKey: true, ctrlKey: false, isComposing: false });
  const sent = readPickMessage(JSON.stringify(q.posted[0]));
  expect(sent !== null && sent !== "cancelled" && sent.submission).toBe("send");
  expect(previewAnnotationContextLabel({ comment: "  ", pageTitle: "Docs" })).toBe("Docs");
  expect(previewAnnotationContextLabel({ comment: "", pageTitle: null })).toBe("Preview annotation");
  expect(previewPickScript({ sendEnabled: false }).startsWith("(function installPreviewPick(cfg, env)")).toBe(true);
});

test("fm13: the marked area is captured through the host as a PNG the composer attaches; a host that cannot capture keeps the annotation without it", async () => {
  const calls: unknown[] = [];
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const shot = await captureAnnotationScreenshot({ x: 80, y: 80, width: 120, height: 70 }, { x: 400, y: 300 }, async (data) => { calls.push(data); return { dataUrl: png, width: 240, height: 140, frame: {} }; });
  expect(calls).toEqual([{ point: { x: 400, y: 300 }, rect: { x: 80, y: 80, width: 120, height: 70 } }]);
  expect(shot).toEqual({ dataUrl: png, width: 240, height: 140, cropRect: { x: 80, y: 80, width: 120, height: 70 } });
  expect(await captureAnnotationScreenshot({ x: 0, y: 0, width: 1, height: 1 }, null, async () => { throw new Error("webview.capture: no handler"); })).toBe(null);
  expect(await captureAnnotationScreenshot(null, null, async () => ({ dataUrl: png, width: 1, height: 1 }))).toBe(null);
  const file = annotationScreenshotFile({ id: "annotation-1", screenshot: shot } as never);
  expect(file?.name).toBe("preview-annotation-annotation-1.png");
  expect(file?.type).toBe("image/png");
});

test("fm13: the annotation editor's mic, dictation shortcut, waveform and elapsed time mirror the app's voice state", () => {
  const p = page();
  installPreviewPick({ sendEnabled: false, theme: {}, voice: true, voiceShortcuts: ["mod+shift+d"], voiceShortcutLabel: "⇧⌘D" }, { window: p.win, document: p.doc });
  p.fireWin("pointerdown", { button: 0, clientX: 120, clientY: 110 });
  const editor = p.html.find((n) => n.className === "editor")!;
  const comment = p.html.find((n) => n.tagName === "TEXTAREA")!;
  const mic = p.html.find((n) => n.attrs["aria-label"] === "Start voice input")!;
  expect(mic.title).toBe("Start voice input (⇧⌘D)");
  comment.value = "Make it";
  editor.fire("keydown", { target: comment, key: "D", ctrlKey: true, shiftKey: true });
  expect(p.posted.at(-1)).toEqual({ t3: "pick", voice: "start", text: "Make it", cursor: 7, selectionEnd: null });
  (p.win as any).__t3pick.voiceState({ available: true, phase: "recording", status: "Recording", preview: "red", level: 0.5 });
  const wave = p.html.find((n) => n.className === "wave")!;
  expect(wave.style.display).toBe("flex");
  expect(wave.children.at(-1)!.style.transform).toBe("scaleY(0.5)");
  expect(p.html.find((n) => n.className === "velapsed")!.textContent).toBe("0:00");
  (p.win as any).__t3pick.voiceState({ available: true, phase: "idle", status: null, preview: null, text: "Make it red", cursor: 11 });
  expect(comment.value).toBe("Make it red");
  expect(wave.style.display).toBe("none");
});
