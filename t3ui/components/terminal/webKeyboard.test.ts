// The keyboard hand-back: the WebView whose page last took focus is the holder; releasing blurs its page, and it stays
// the holder (still first responder, so it is parked, not hidden) until it unregisters.
import { expect, test } from "nsh/test";
import { clearWebViewFocus, groupHoldsWebKeyboard, holdsWebKeyboard, nativeWebFocus, noteHostFocusProbe, notePointerOverComposer, pageBlurredByPress, pointerOverComposer, setComposerFocus, noteWebViewFocus, registerWebKeyboard, releaseWebKeyboard, resetWebKeyboardForTests, setAppEditorRelease, webKeyboardHeld, webViewTookKeyboard } from "./webKeyboard";

test("release blurs the page that took focus last, and only that one", () => {
  resetWebKeyboardForTests();
  const blurred: string[] = [];
  const offA = registerWebKeyboard("drawer-1:t1", () => blurred.push("a"));
  registerWebKeyboard("drawer-2:t2", () => blurred.push("b"));
  releaseWebKeyboard();
  expect(blurred).toEqual([]);
  noteWebViewFocus("drawer-1:t1", "drawer-1");
  expect(holdsWebKeyboard("drawer-1:t1")).toBe(true);
  expect(groupHoldsWebKeyboard("drawer-1")).toBe(true);
  expect(groupHoldsWebKeyboard("drawer-2")).toBe(false);
  releaseWebKeyboard();
  expect(blurred).toEqual(["a"]);
  expect(holdsWebKeyboard("drawer-1:t1")).toBe(true);
  noteWebViewFocus("drawer-2:t2", "drawer-2");
  releaseWebKeyboard();
  expect(blurred).toEqual(["a", "b"]);
  expect(groupHoldsWebKeyboard("drawer-1")).toBe(false);
  offA();
  expect(holdsWebKeyboard("drawer-2:t2")).toBe(true);
});

test("a holder that unmounts stops holding", () => {
  resetWebKeyboardForTests();
  const off = registerWebKeyboard("panel:t9", () => {});
  noteWebViewFocus("panel:t9", "panel");
  off();
  expect(holdsWebKeyboard("panel:t9")).toBe(false);
  expect(groupHoldsWebKeyboard("panel")).toBe(false);
});

test("the host focus probe turns native WebView focus on only when the page really had the keyboard", () => {
  resetWebKeyboardForTests();
  expect(noteHostFocusProbe({ type: "focus-state", focused: true })).toBe(false);
  expect(noteHostFocusProbe({ type: "host-focus", focused: false })).toBe(true);
  expect(nativeWebFocus()).toBe(false);
  expect(noteHostFocusProbe({ type: "host-focus", focused: true })).toBe(true);
  expect(nativeWebFocus()).toBe(true);
  // A later answer from a page that lost the keyboard does not take the capability away.
  noteHostFocusProbe({ type: "host-focus", focused: false });
  expect(nativeWebFocus()).toBe(true);
  resetWebKeyboardForTests();
  expect(nativeWebFocus()).toBe(false);
});

test("a page that took the keyboard by a click is noted only after the prompt editors let go", async () => {
  resetWebKeyboardForTests();
  let letGo: () => void = () => {};
  let asked = 0;
  setAppEditorRelease(() => { asked += 1; return new Promise<void>((resolve) => { letGo = resolve; }); });
  webViewTookKeyboard("panel:t1", "panel", () => true);
  expect(asked).toBe(1);
  // While the editor still reports its focus, nothing reads "a web view holds the keyboard": the composer does not
  // take the click for a hand-back and blur the page.
  expect(webKeyboardHeld()).toBe(false);
  letGo();
  await Promise.resolve();
  await Promise.resolve();
  expect(holdsWebKeyboard("panel:t1")).toBe(true);
  resetWebKeyboardForTests();
});

test("a page that lost the focus again before the editors let go is not noted", async () => {
  resetWebKeyboardForTests();
  let letGo: () => void = () => {};
  setAppEditorRelease(() => new Promise<void>((resolve) => { letGo = resolve; }));
  let focused = true;
  webViewTookKeyboard("panel:t1", "panel", () => focused);
  focused = false;
  letGo();
  await Promise.resolve();
  await Promise.resolve();
  expect(webKeyboardHeld()).toBe(false);
  resetWebKeyboardForTests();
});

test("clearing the holder only drops the web view that holds the keyboard", () => {
  resetWebKeyboardForTests();
  noteWebViewFocus("panel:t1", "panel");
  clearWebViewFocus("panel:t2");
  expect(holdsWebKeyboard("panel:t1")).toBe(true);
  clearWebViewFocus("panel:t1");
  expect(webKeyboardHeld()).toBe(false);
});

test("a page blur from a press on the composer hands the composer the keyboard; elsewhere it does nothing", () => {
  resetWebKeyboardForTests();
  let focused = 0;
  const off = setComposerFocus(() => { focused += 1; });
  pointerOverComposer.set(false);
  expect(pageBlurredByPress()).toBe(false);
  expect(focused).toBe(0);
  pointerOverComposer.set(true);
  expect(pageBlurredByPress()).toBe(true);
  expect(focused).toBe(1);
  pointerOverComposer.set(false);
  expect(pageBlurredByPress(1000)).toBe(false);
  notePointerOverComposer(true, 1200);
  expect(focused).toBe(2);
  notePointerOverComposer(false, 1300);
  expect(pageBlurredByPress(2000)).toBe(false);
  notePointerOverComposer(true, 3000);
  expect(focused).toBe(2);
  off();
  pointerOverComposer.set(false);
});
