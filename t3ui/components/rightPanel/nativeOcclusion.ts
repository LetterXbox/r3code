// Native view occlusion. A WebView (preview browser, terminal tabs, the terminal drawer, the provider auth
// terminal) is a native view the host draws above every GPUI element, so no z-index can put a menu, dialog or
// popover over it. Anything floating that can overlap a WebView registers here while it is open; every WebView
// host reads `nativeViewOccluded()` and, while it is true, hides its WebView (display: none, the page keeps
// running) and shows a neutral placeholder, so the floating surface is fully visible.
//
// The WebView API offers no snapshot/capture and no frame inset, so hiding is the least disruptive option.
//
// Usage in a component that owns an overlay:
//   useOverlayOpen(() => menuOpen());          // a signal or accessor
//   const release = registerOverlay("my menu"); // imperative; call release() when it closes
import { effect, host, signal, untracked } from "nsh";
import { addProjectOpen } from "../SidebarAddProjectState";
import { paletteOpen, settingsOpen, usageOpen } from "../../store";

// Whether the host places WebViews below GPUI's own content instead of above it is the host's to say: a host with the
// own-webview patch (third_party/nsh-host/README.md) answers `host.call("webview.underSurface")` with true. The prebuilt
// host and a headless test have no such handler and reject, so every function below behaves exactly as it does today.
// `T3GPUI_WEBVIEW_UNDER_SURFACE` (forwarded by tools/run_local.py) is only a test override of that answer: "1" forces
// it on, "0" forces it off, unset leaves it to the host.
const underSurfaceEnvironment = process.env.T3GPUI_WEBVIEW_UNDER_SURFACE;
const underSurfaceFromEnvironment = underSurfaceEnvironment === "1" ? true : underSurfaceEnvironment === "0" ? false : null;
const underSurfaceFromHost = signal(false);
const underSurfaceOverride = signal<boolean | null>(null);

/** True when the host draws WebViews below the app's own content: menus and dialogs draw over a live page, so nothing steps aside. */
export function webViewsUnderSurface(): boolean {
  return underSurfaceOverride() ?? underSurfaceFromEnvironment ?? underSurfaceFromHost();
}

function askHostUnderSurface(): Promise<unknown> {
  if (!host.available()) return Promise.resolve(false);
  return host.call("webview.underSurface", null);
}

/**
 * Asks the host whether it shows WebViews under the app's surface, and notes the answer (only `true` counts; a host
 * that rejects or does not know the name leaves it false). Runs once when this module loads; `ask` is for tests.
 */
export function detectWebViewsUnderSurface(ask: () => Promise<unknown> = askHostUnderSurface): Promise<void> {
  let asked: Promise<unknown>;
  try { asked = ask(); } catch { asked = Promise.resolve(false); /* no host bridge (headless) */ }
  return asked.then((value) => { underSurfaceFromHost.set(value === true); }, () => { underSurfaceFromHost.set(false); });
}

void detectWebViewsUnderSurface();

/** Tests choose the host kind without the environment variable; null goes back to the environment's. */
export function overrideWebViewsUnderSurface(next: boolean | null) {
  underSurfaceOverride.set(next);
}

const entries = signal<readonly string[]>([]);
let sequence = 0;

/** Marks one overlay open until the returned release runs (safe to call more than once). */
export function registerOverlay(label = "overlay"): () => void {
  const id = `${label}#${++sequence}`;
  untracked(() => entries.update((all) => [...all, id]));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    untracked(() => entries.update((all) => all.filter((entry) => entry !== id)));
  };
}

/** Registers while `source` is true (a boolean or an accessor), releasing on false and on disposal. */
export function useOverlayOpen(source: boolean | (() => boolean), label = "overlay", lingerMs = 0): void {
  effect(() => {
    const open = typeof source === "function" ? source() : source;
    if (!open) return;
    const release = registerOverlay(label);
    // `lingerMs`: an overlay that plays an exit stays registered until it has finished, so no WebView comes back over it.
    return lingerMs > 0 ? () => { setTimeout(release, lingerMs); } : release;
  });
}

/** The `onOpenChange` of a Menu / Popover / Dialog that owns no open signal of its own: tracks the open state in `state`. */
export function trackOpenChange(state: { set(value: boolean): void }, next?: (event: { open: boolean }) => void) {
  return (event: { open: boolean }) => { state.set(event.open); next?.(event); };
}

/** Labels of the registered overlays (tests, diagnostics). */
export function registeredOverlays(): readonly string[] {
  return entries();
}

/** Labels of the registered overlays without their sequence suffix (debugging a leaked registration). */
export function openOverlayLabels(): readonly string[] {
  return [...entries(), ...floating().map((entry) => entry.id)].map((entry) => entry.replace(/#\d+$/, ""));
}

/** The app-level overlays (settings, usage, palette, add project) that always cover the thread view. */
export function appOverlayOpen(): boolean {
  return settingsOpen() || usageOpen() || paletteOpen() || addProjectOpen();
}

/** True while a registered overlay is open, ignoring the app-level ones (a WebView inside Settings itself). */
export function registeredOverlayOpen(): boolean {
  return entries().length > 0;
}

/** A rectangle in page (root view) coordinates, in points. */
export type PageRect = { x: number; y: number; width: number; height: number };

const floating = signal<readonly { id: string; rect: PageRect }[]>([]);

/**
 * Registers a floating surface that only occludes the WebViews it actually overlaps (toasts, tooltips):
 * `rect` is its page rectangle while it shows, null while it does not.
 */
export function useFloatingRect(rect: () => PageRect | null, label = "floating"): void {
  effect(() => {
    const current = rect();
    if (!current) return;
    const id = `${label}#${++sequence}`;
    untracked(() => floating.update((all) => [...all, { id, rect: current }]));
    return () => untracked(() => floating.update((all) => all.filter((entry) => entry.id !== id)));
  });
}

/** Whether two page rectangles intersect (touching edges do not count). */
export function rectsOverlap(a: PageRect, b: PageRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** True when a registered floating surface overlaps `own` (a WebView host's page rectangle; unknown: false). */
export function overlapsFloating(own?: PageRect | null): boolean {
  const all = floating();
  if (!own || all.length === 0) return false;
  return all.some((entry) => rectsOverlap(entry.rect, own));
}

/** Measures `node` into `target` as a page rectangle (pass to a host View's `onLayout`). */
export function measureInto(node: { measure(): Promise<{ bounds: { size: { width: number; height: number } }; pagePosition: { x: number; y: number } } | null> } | undefined, target: { set(value: PageRect | null): void }): void {
  void node?.measure().then((m) => target.set(m ? { x: m.pagePosition.x, y: m.pagePosition.y, width: m.bounds.size.width, height: m.bounds.size.height } : null)).catch(() => {});
}

/** True while any registered overlay or app-level overlay is open, or a floating surface overlaps `own`: WebView hosts step aside. */
export function nativeViewOccluded(own?: PageRect | null): boolean {
  if (webViewsUnderSurface()) return false;
  return entries().length > 0 || appOverlayOpen() || overlapsFloating(own);
}

/**
 * True while a registered overlay or an app-level one is open, whichever way the host stacks WebViews. Keyboard hand-back
 * reads this (a menu, palette or dialog takes typing from a terminal page on either host); hiding a WebView reads
 * `nativeViewOccluded`, which is always false when WebViews sit under the app's surface.
 */
export function overlayOpen(): boolean {
  return entries().length > 0 || appOverlayOpen();
}

/** The label the right panel's narrow-layout sheet registers under. */
export const PANEL_SHEET_LABEL = "right panel sheet";

/** Like `nativeViewOccluded`, for a web view that lives inside the right panel: the panel's own sheet does not cover it. */
export function panelViewOccluded(own?: PageRect | null): boolean {
  if (webViewsUnderSurface()) return false;
  return entries().some((entry) => !entry.startsWith(`${PANEL_SHEET_LABEL}#`)) || appOverlayOpen() || overlapsFloating(own);
}

/** True while an overlay other than the right panel's own sheet is open (a menu or dialog over it takes Escape first). */
export function overlayOpenBesidesSheet(): boolean {
  return entries().some((entry) => !entry.startsWith(`${PANEL_SHEET_LABEL}#`)) || appOverlayOpen();
}
