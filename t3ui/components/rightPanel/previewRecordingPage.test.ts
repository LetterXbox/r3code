import { expect, test } from "nsh/test";
import { installPreviewRecording } from "./previewRecordingPage";
import { recordingKeyLabel, recordingKeysAreSensitive } from "./recordingInput";

function page() {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const docListeners: Record<string, ((e: any) => void)[]> = {};
  let active: any = null;
  const nodes: any[] = [];
  const makeNode = () => {
    const node: any = {
      style: {}, children: [], attrs: {},
      setAttribute(k: string, v: string) { node.attrs[k] = v; },
      getAttribute(k: string) { return node.attrs[k] ?? null; },
      append(...cs: any[]) { node.children.push(...cs); },
      remove() {},
      matches() { return false; },
      showPopover() {},
      hidePopover() {},
      isConnected: true,
    };
    nodes.push(node);
    return node;
  };
  const doc: any = {
    createElement: () => makeNode(),
    documentElement: { append: (...cs: any[]) => cs.forEach(() => {}) },
    get activeElement() { return active; },
    addEventListener: (t: string, fn: any) => { (docListeners[t] ??= []).push(fn); },
    removeEventListener: (t: string, fn: any) => { docListeners[t] = (docListeners[t] ?? []).filter((f) => f !== fn); },
  };
  const posted: any[] = [];
  const win: any = {
    navigator: { platform: "MacIntel" },
    innerWidth: 800, innerHeight: 600,
    nsh: { postMessage: (m: string) => posted.push(JSON.parse(m)) },
    addEventListener: (t: string, fn: any) => { (listeners[t] ??= []).push(fn); },
    removeEventListener: (t: string, fn: any) => { listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn); },
    requestAnimationFrame: (fn: () => void) => { fn(); return 1; },
    cancelAnimationFrame: () => {},
    clearTimeout: () => {}, setTimeout: () => 0,
    MutationObserver: undefined,
  };
  (win as any).MutationObserver = class { observe() {} disconnect() {} };
  const fire = (t: string, e: any) => { for (const fn of [...(listeners[t] ?? [])]) fn({ pointerType: "mouse", clientX: 0, clientY: 0, relatedTarget: null, ...e }); };
  return { doc, win, posted, fire, setActive: (el: any) => { active = el; } };
}

test("fm13: installPreviewRecording posts pointer input only while showMousePresses is on and the button is held", () => {
  const { doc, win, posted, fire } = page();
  installPreviewRecording({ showKeyPresses: false, showMousePresses: true }, { window: win, document: doc });
  fire("pointerdown", { clientX: 10, clientY: 20 });
  fire("pointermove", { clientX: 15, clientY: 25 });
  fire("pointerup", { clientX: 15, clientY: 25 });
  expect(posted.map((m) => m.input.phase)).toEqual(["down", "move", "up"]);
  expect(posted[0].input).toEqual({ type: "pointer", phase: "down", x: 10, y: 20, width: 800, height: 600 });
});

test("fm13: installPreviewRecording posts key labels only while showKeyPresses is on, null for a sensitive field", () => {
  const { doc, win, posted, fire, setActive } = page();
  installPreviewRecording({ showKeyPresses: true, showMousePresses: false }, { window: win, document: doc });
  fire("keydown", { key: "k", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false });
  expect(posted[0]).toEqual({ t3: "recordingInput", input: { type: "key", label: "⌘K", held: true, width: 800 } });
  setActive({ tagName: "INPUT", getAttribute: (n: string) => (n === "type" ? "password" : null) });
  fire("keydown", { key: "a", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false });
  expect(posted[1].input.label).toBe(null);
});

test("fm13: no mouse/key input is posted while both options are off", () => {
  const { doc, win, posted, fire } = page();
  installPreviewRecording({ showKeyPresses: false, showMousePresses: false }, { window: win, document: doc });
  fire("pointerdown", { clientX: 1, clientY: 1 });
  fire("keydown", { key: "a", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false });
  expect(posted).toEqual([]);
});

test("fm13: the page's key label and sensitivity check match recordingInput.ts (parity)", () => {
  const { doc, win, posted, fire } = page();
  installPreviewRecording({ showKeyPresses: true, showMousePresses: false }, { window: win, document: doc });
  fire("keydown", { key: "Enter", metaKey: false, ctrlKey: false, altKey: true, shiftKey: true, isComposing: false, repeat: false });
  const expected = recordingKeyLabel({ key: "Enter", metaKey: false, ctrlKey: false, altKey: true, shiftKey: true }, true);
  expect(posted[0].input.label).toBe(expected);
  expect(recordingKeysAreSensitive({ activeElement: { tagName: "IFRAME" } } as any)).toBe(true);
});
