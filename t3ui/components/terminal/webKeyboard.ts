// Giving the keyboard back from a WebView on the GPUI host (workspace/nsh-runtime-bugs.md, "First-responder hand-back").
//
// A click into a WebView makes its WKWebView the window's first responder, and nothing the app can call moves it back to
// GPUI's view (the host ignores WebView focus/blur, and GPUI's view never takes first responder on a click). Two facts,
// seen in a fixture window (workspace/termfix/fixture.tsx), give a working hand-back:
//   1. A WKWebView whose page has no focused element does not take the keys: they go up the responder chain to GPUI's
//      view, so app fields type again. Blurring the page's focused element (injected script) is the hand-back.
//   2. A WKWebView that is hidden (class "hidden", display none, opacity 0, clipped away) or removed while it is the first
//      responder takes the keyboard with it: no key reaches the app until another WebView is clicked. So the WebView that
//      holds it is never hidden: it is parked as a 1x1 point instead, its page blurred.
import { host, signal } from "nsh";

/** Blurs whatever has the page's focus, so the WKWebView passes keys on to the app. */
export const PAGE_BLUR_SCRIPT = "(function(){var a=document.activeElement;if(a&&a!==document.body&&a.blur)a.blur();})();";

/**
 * Blurs the page's focused element only when the page lost the window's focus to the app (not to a click inside the page,
 * which refocuses its own input): the hand-back after a click on app content.
 */
export const PAGE_BLUR_IF_UNFOCUSED_SCRIPT = "setTimeout(function(){if(document.hasFocus())return;var a=document.activeElement;if(a&&a!==document.body&&a.blur)a.blur();},0);";

/** Where a WebView that holds the keyboard waits while it must not show: one point at its container's bottom left. */
export const PARKED_WEBVIEW_STYLE = { position: "absolute", left: 0, bottom: 0, width: 1, height: 1 } as const;

/**
 * A host with the WebView focus fix (third_party/nsh-host, patch 0001) carries out `WebViewRef.focus()` / `blur()`; the
 * prebuilt host ignores both. Feature-detected, never assumed: after a `focus()` the page answers this probe with
 * `{ type: "host-focus", focused: document.hasFocus() }`, true only when its WKWebView really became first responder.
 */
export const HOST_FOCUS_PROBE_SCRIPT = "setTimeout(function(){window.nsh.postMessage(JSON.stringify({type:'host-focus',focused:document.hasFocus()}));},150);";

/** True once a page reported that `focus()` gave it the keyboard (the host moves first responder natively). */
export const nativeWebFocus = signal(false);

/** A page's answer to HOST_FOCUS_PROBE_SCRIPT. True when the message was that answer. */
export function noteHostFocusProbe(message: Record<string, unknown>): boolean {
  if (message.type !== "host-focus") return false;
  if (message.focused === true && !nativeWebFocus()) nativeWebFocus.set(true);
  return true;
}

type Holder = { id: string; group: string };

/** The WebView whose WKWebView is the window's first responder: the last one whose page reported focus. */
const holder = signal<Holder | null>(null);
const releasers = new Map<string, () => void>();

/** A WebView that can hold the keyboard registers how to blur its page. Returns the unregister function. */
export function registerWebKeyboard(id: string, release: () => void): () => void {
  releasers.set(id, release);
  return () => {
    if (releasers.get(id) === release) releasers.delete(id);
    if (holder()?.id === id) holder.set(null);
  };
}

/** The page of `id` (in `group`, e.g. a drawer) took the keyboard: a real click made its WKWebView first responder. */
export function noteWebViewFocus(id: string, group: string) {
  const current = holder();
  if (current?.id !== id || current.group !== group) holder.set({ id, group });
}

/** `id` no longer holds the keyboard: on a host that moves first responder natively its WKWebView gave it back. */
export function clearWebViewFocus(id: string) {
  if (holder()?.id === id) holder.set(null);
}

// How the app's own prompt editors give the keyboard up (PromptEditor.tsx registers `releasePromptKeyboard`).
let releaseAppEditors: () => Promise<void> = () => Promise.resolve();
export function setAppEditorRelease(release: () => Promise<void>) { releaseAppEditors = release; }

/**
 * The page of `id` took the keyboard by a real click. A click into a web view does not reach the app, so a prompt editor
 * that had the focus still reports it: it gives the keyboard up first, and only then is the WebView noted as the holder.
 * (Noted while the editor still read "focused", the composer took the click for "the editor was focused while a web view
 * holds the keyboard", blurred the page and typed the keys into itself: the terminal could not be typed into.)
 */
export function webViewTookKeyboard(id: string, group: string, stillFocused: () => boolean) {
  void releaseAppEditors().then(() => { if (stillFocused()) noteWebViewFocus(id, group); });
}

// A press on the composer while a terminal page has the keyboard (prebuilt host): the press never reaches the RichEditor
// (workspace/nsh-runtime-bugs.md defect 4), only the page's blur report says it happened. The composer reports whether
// the pointer is over it and how to focus it; the page's unsolicited blur then hands it the keyboard by `focus()`, which
// works while a WKWebView is first responder. Without this the composer never took the keyboard after a terminal click:
// the drawer kept `drawerTypingWanted`, and every key went on to the shell until the UI was reloaded.
export const pointerOverComposer = signal(false);
let focusComposer: () => void = () => {};
export function setComposerFocus(focus: () => void): () => void {
  focusComposer = focus;
  return () => { if (focusComposer === focus) focusComposer = () => {}; };
}
let blurredAt = -Infinity;
/** The page of a terminal lost the focus without the app asking. True when the composer was pressed and took the keyboard. */
export function pageBlurredByPress(now = Date.now()): boolean {
  if (!pointerOverComposer()) { blurredAt = now; return false; }
  blurredAt = -Infinity;
  focusComposer();
  return true;
}
/** The composer reports the pointer entering or leaving it. A press can be reported before the move that brought the
 * pointer there (seen with posted events): a page blur just before the pointer came in counts as that press. */
export function notePointerOverComposer(over: boolean, now = Date.now()) {
  pointerOverComposer.set(over);
  if (over && now - blurredAt < 400) { blurredAt = -Infinity; focusComposer(); }
}

let askedHost = false;
/**
 * Asks the host once whether it moves the keyboard natively (third_party/nsh-host, `webview.nativeFocus`: a host with the
 * WebView focus patches answers true; the prebuilt host and a headless test have no such handler and reject).
 */
export function detectNativeWebFocus() {
  if (askedHost) return;
  askedHost = true;
  try {
    if (!host.available()) return;
    void host.call("webview.nativeFocus", null).then((value) => { if (value === true) nativeWebFocus.set(true); }, () => {});
  } catch { /* no host bridge (headless) */ }
}

/** True while `id` is the WebView that holds the window's keyboard (it must be parked, not hidden). */
export const holdsWebKeyboard = (id: string) => holder()?.id === id;

/** True while some WebView holds the window's keyboard (a click on app content then may not focus a RichEditor). */
export const webKeyboardHeld = () => holder() !== null;

/** True while a WebView of `group` holds the window's keyboard. */
export const groupHoldsWebKeyboard = (group: string) => holder()?.group === group;

/** Gives the keyboard back to the app: blurs the holder's page (the holder stays first responder, so stays parked). */
export function releaseWebKeyboard() {
  const current = holder();
  if (current) releasers.get(current.id)?.();
}

export function resetWebKeyboardForTests() {
  holder.set(null);
  nativeWebFocus.set(false);
  releasers.clear();
  releaseAppEditors = () => Promise.resolve();
  askedHost = false;
  blurredAt = -Infinity;
  pointerOverComposer.set(false);
}
