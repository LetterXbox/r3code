import { expect, test } from "nsh/test";
import { installPreviewPick, readPickMessage } from "./previewPick";

// A small DOM, trimmed from previewPick.test.ts's harness: enough for the annotation layer plus the "Style" panel
// (toolbar, editor, textarea, style inputs, listeners). Kept separate so a change to one harness cannot silently
// break the other suite's assumptions.
class Node_ {
  children: Node_[] = []; parent: Node_ | null = null; style: Record<string, string> = {}; attrs: Record<string, string> = {}; listeners: Record<string, ((e: any) => void)[]> = {};
  className = ""; textContent = ""; value = ""; placeholder = ""; rows = 1; type = ""; title = ""; id = ""; outerHTML = ""; scrollHeight = 20;
  rect = { left: 0, top: 0, width: 0, height: 0 };
  classList = { add: (c: string) => { if (!this.className.split(" ").includes(c)) this.className = `${this.className} ${c}`.trim(); }, remove: (c: string) => { this.className = this.className.split(" ").filter((x) => x !== c).join(" "); } };
  constructor(public tagName: string) { this.style = new Proxy({} as Record<string, string>, {}); }
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
  findAll(pred: (n: Node_) => boolean): Node_[] { const out: Node_[] = []; const walk = (n: Node_) => { if (pred(n)) out.push(n); n.children.forEach(walk); }; walk(this); return out; }
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
  return { html, button, posted, doc, win, fireWin };
}

function select(p: ReturnType<typeof page>) {
  p.fireWin("pointerdown", { button: 0, clientX: 120, clientY: 110 });
}

function openStylePanel(p: ReturnType<typeof page>) {
  const styleToggle = p.html.find((n) => n.tagName === "BUTTON" && n.textContent === "Style")!;
  styleToggle.fire("click", {});
  return styleToggle;
}

test("the Style toggle is disabled until an element is selected, then reveals the style panel", () => {
  const p = page();
  installPreviewPick({ sendEnabled: false, theme: {} }, { window: p.win, document: p.doc });
  const styleToggle = p.html.find((n) => n.tagName === "BUTTON" && n.textContent === "Style")!;
  expect(styleToggle.hasAttribute("disabled")).toBe(true);
  select(p);
  expect(styleToggle.hasAttribute("disabled")).toBe(false);
  openStylePanel(p);
  const panel = p.html.find((n) => n.className === "stylepanel")!;
  expect(panel.style.display).toBe("flex");
});

test("font size, text colour and padding edits apply live and are reported as styleChanges on submit", () => {
  const p = page();
  installPreviewPick({ sendEnabled: false, theme: {} }, { window: p.win, document: p.doc });
  select(p);
  openStylePanel(p);
  const fontSize = p.html.find((n) => n.attrs["aria-label"] === "Font size in pixels")!;
  fontSize.value = "24"; fontSize.fire("input", {});
  const color = p.html.find((n) => n.attrs["aria-label"] === "Text colour")!;
  color.value = "#ff0000"; color.fire("input", {});
  const padding = p.html.find((n) => n.attrs["aria-label"] === "Padding")!;
  padding.value = "8px 12px"; padding.fire("change", {});
  // Applied live to the selected element's inline style.
  expect(p.button.style.fontSize).toBe("24px");
  expect(p.button.style.color).toBe("#ff0000");
  expect(p.button.style.padding).toBe("8px 12px");

  const editor = p.html.find((n) => n.className === "editor")!;
  const comment = p.html.find((n) => n.tagName === "TEXTAREA")!;
  comment.value = "Make it bigger and red";
  editor.fire("keydown", { target: comment, key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false });
  const message = readPickMessage(JSON.stringify(p.posted[0]));
  if (message === null || message === "cancelled") throw new Error("no annotation");
  const changes = message.annotation.styleChanges;
  expect(changes.length).toBe(3);
  const byProperty = Object.fromEntries(changes.map((c) => [c.property, c]));
  expect(byProperty["font-size"]).toEqual({ targetId: message.annotation.elements[0]!.id, selector: null, property: "font-size", previousValue: "", value: "24px" });
  expect(byProperty["color"].value).toBe("#ff0000");
  expect(byProperty["padding"].value).toBe("8px 12px");
  // restoreStyles: the test's immediate setTimeout stands in for the host's capture guard, so teardown has already
  // run and the live edits reverted — the data already travelled in the posted payload.
  expect(p.button.style.fontSize).toBe("");
});

test("deselecting (or erasing) a target reverts its style and drops its styleChanges", () => {
  const p = page();
  installPreviewPick({ sendEnabled: false, theme: {} }, { window: p.win, document: p.doc });
  select(p);
  openStylePanel(p);
  const fontSize = p.html.find((n) => n.attrs["aria-label"] === "Font size in pixels")!;
  fontSize.value = "30"; fontSize.fire("input", {});
  expect(p.button.style.fontSize).toBe("30px");
  // Clicking the same element again (still in "select" tool) deselects it.
  p.fireWin("pointerdown", { button: 0, clientX: 120, clientY: 110 });
  expect(p.button.style.fontSize).toBe("");
  const editor = p.html.find((n) => n.className === "editor")!;
  expect(editor.style.display).toBe("none");
});
