import { expect, test } from "nsh/test";
import { effect, signal } from "nsh";
import { closeSettings, openSettings } from "../../store";
import { detectWebViewsUnderSurface, PANEL_SHEET_LABEL, nativeViewOccluded, overlayOpen, overrideWebViewsUnderSurface, panelViewOccluded, registeredOverlayOpen, registeredOverlays, registerOverlay, useFloatingRect, useOverlayOpen, webViewsUnderSurface } from "./nativeOcclusion";

test("a registered overlay occludes native views until released, once", () => {
  expect(nativeViewOccluded()).toBe(false);
  const a = registerOverlay("a");
  const b = registerOverlay("b");
  expect(nativeViewOccluded()).toBe(true);
  expect(registeredOverlays().length).toBe(2);
  a();
  a();
  expect(nativeViewOccluded()).toBe(true);
  b();
  expect(nativeViewOccluded()).toBe(false);
  expect(registeredOverlayOpen()).toBe(false);
});

test("useOverlayOpen follows a signal and app-level overlays also occlude", () => {
  const open = signal(false);
  useOverlayOpen(() => open(), "menu");
  let seen = false;
  effect(() => { seen = nativeViewOccluded(); });
  expect(seen).toBe(false);
  open.set(true);
  expect(seen).toBe(true);
  open.set(false);
  expect(seen).toBe(false);
  openSettings();
  expect(seen).toBe(true);
  expect(registeredOverlayOpen()).toBe(false);
  closeSettings();
  expect(seen).toBe(false);
});

test("the panel's own sheet covers what is behind it but not the web views inside it", () => {
  const sheet = registerOverlay(PANEL_SHEET_LABEL);
  expect(nativeViewOccluded()).toBe(true);
  expect(panelViewOccluded()).toBe(false);
  const menu = registerOverlay("panel tab menu");
  expect(panelViewOccluded()).toBe(true);
  menu();
  sheet();
  expect(nativeViewOccluded()).toBe(false);
});

test("web views under the surface: nothing is occluded, whatever opens, and the overlays are still known", () => {
  expect(webViewsUnderSurface()).toBe(false);
  overrideWebViewsUnderSurface(true);
  try {
    const own = { x: 0, y: 0, width: 100, height: 100 };
    let occluded = false;
    let panelOccluded = false;
    effect(() => { occluded = nativeViewOccluded(own); panelOccluded = panelViewOccluded(own); });
    const menu = registerOverlay("menu");
    const sheet = registerOverlay(PANEL_SHEET_LABEL);
    const floating = signal<{ x: number; y: number; width: number; height: number } | null>({ x: 10, y: 10, width: 20, height: 20 });
    useFloatingRect(() => floating(), "toast");
    openSettings();
    expect(occluded).toBe(false);
    expect(panelOccluded).toBe(false);
    // The keyboard hand-back still learns that something is open.
    expect(overlayOpen()).toBe(true);
    expect(registeredOverlayOpen()).toBe(true);
    closeSettings();
    menu();
    sheet();
    floating.set(null);
    expect(overlayOpen()).toBe(false);
    expect(occluded).toBe(false);
  } finally {
    overrideWebViewsUnderSurface(null);
  }
});

test("web views above the surface: the same overlays occlude as before, and overlayOpen agrees with them", () => {
  overrideWebViewsUnderSurface(false);
  try {
    const own = { x: 0, y: 0, width: 100, height: 100 };
    const menu = registerOverlay("menu");
    expect(nativeViewOccluded(own)).toBe(true);
    expect(panelViewOccluded(own)).toBe(true);
    expect(overlayOpen()).toBe(true);
    menu();
    expect(nativeViewOccluded(own)).toBe(false);
    expect(overlayOpen()).toBe(false);
    openSettings();
    expect(nativeViewOccluded()).toBe(true);
    expect(overlayOpen()).toBe(true);
    closeSettings();
    // A toast over the view occludes that view only; it is not an overlay that takes the keyboard.
    const floating = signal<{ x: number; y: number; width: number; height: number } | null>({ x: 10, y: 10, width: 20, height: 20 });
    useFloatingRect(() => floating(), "toast");
    expect(nativeViewOccluded(own)).toBe(true);
    expect(nativeViewOccluded({ x: 500, y: 500, width: 10, height: 10 })).toBe(false);
    expect(overlayOpen()).toBe(false);
    floating.set(null);
    expect(nativeViewOccluded(own)).toBe(false);
  } finally {
    overrideWebViewsUnderSurface(null);
  }
});

test("the host says whether web views sit under the surface: only an answer of true turns occlusion off", async () => {
  // No host bridge here (headless), as on the prebuilt host: the module's own question left it false.
  expect(webViewsUnderSurface()).toBe(false);
  const menu = registerOverlay("menu");
  try {
    let occluded = false;
    effect(() => { occluded = nativeViewOccluded(); });
    expect(occluded).toBe(true);
    // A host without the handler rejects the call (the prebuilt host): nothing changes.
    await detectWebViewsUnderSurface(() => Promise.reject(new Error("the embedding app handles no webview.underSurface")));
    expect(webViewsUnderSurface()).toBe(false);
    expect(occluded).toBe(true);
    // A host that answers anything but true (NSH_WEBVIEW_ABOVE, Windows, Linux): nothing changes.
    await detectWebViewsUnderSurface(() => Promise.resolve(false));
    await detectWebViewsUnderSurface(() => Promise.resolve("yes"));
    expect(webViewsUnderSurface()).toBe(false);
    // A bridge that throws at once is a host that does not know.
    await detectWebViewsUnderSurface(() => { throw new Error("no bridge"); });
    expect(webViewsUnderSurface()).toBe(false);
    // The combined host answers true: what was already built stops stepping aside, live.
    await detectWebViewsUnderSurface(() => Promise.resolve(true));
    expect(webViewsUnderSurface()).toBe(true);
    expect(occluded).toBe(false);
    expect(overlayOpen()).toBe(true);
    // A test's override still wins over the host's answer.
    overrideWebViewsUnderSurface(false);
    expect(webViewsUnderSurface()).toBe(false);
    expect(occluded).toBe(true);
    overrideWebViewsUnderSurface(null);
    expect(webViewsUnderSurface()).toBe(true);
  } finally {
    overrideWebViewsUnderSurface(null);
    await detectWebViewsUnderSurface(() => Promise.resolve(false));
    menu();
  }
  expect(webViewsUnderSurface()).toBe(false);
});
