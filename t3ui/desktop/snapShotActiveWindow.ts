// apps/desktop/src/snapShot/ActiveWindow.ts (macOS half): the frontmost app's visible layer-0 windows, by the reference's JXA
// lookup (osascript, through `process.run`), then the reference's pick: the first window with a title, or the first untitled one
// that is not a thin helper strip along the edge of a later window. The capture then takes that window by id
// (`screencapture -l <id>`, MacSnapShot.ts macSnapShotArguments).
//
// One difference the port cannot avoid: the reference's shortcut is global, so the frontmost app is the one the user was in. The
// port's shortcut is app-level only (no global hotkeys), so the frontmost app is usually R3 Code itself; the lookup reports that
// as `self` (the frontmost app is osascript's parent, this process) and the capture falls back to letting the user pick a window.
import { host } from "nsh";
import { desktop } from "./runtime";

export interface ActiveWindow {
  platform: "macos";
  /** CGWindowNumber. */
  id: number;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  owner: { name: string; processId: number; path: string; bundleId?: string };
}

interface LookupWindow { id: number; title: string; bounds: ActiveWindow["bounds"]; alpha: number }
interface Lookup { owner: { name: string; processId: number; path: string; bundleId: string }; self: boolean; windows: LookupWindow[] }

const MAC_LOOKUP_TIMEOUT_MS = 5_000;
const MAC_HELPER_STRIP_MAX_THICKNESS_RATIO = 0.25;

/** The reference's MAC_LOOKUP_SCRIPT, plus `self`: whether the frontmost app is this process (osascript's parent). */
export const MAC_ACTIVE_WINDOW_SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
ObjC.bindFunction("getppid", ["int", []]);
function run() {
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (app.isNil()) return "";
  const pid = app.processIdentifier;
  let ownerName = String(app.localizedName.js || "");
  const list = $.CGWindowListCopyWindowInfo(
    $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements,
    $.kCGNullWindowID,
  );
  $.CFMakeCollectable(list);
  const count = $.CFArrayGetCount(list);
  const windows = [];
  for (let i = 0; i < count; i++) {
    const w = ObjC.castRefToObject($.CFArrayGetValueAtIndex(list, i));
    if (w.objectForKey("kCGWindowOwnerPID").js !== pid) continue;
    if (w.objectForKey("kCGWindowLayer").js !== 0) continue;
    if (!ownerName) {
      ownerName = String(ObjC.unwrap(w.objectForKey("kCGWindowOwnerName")) || "");
    }
    const b = ObjC.deepUnwrap(w.objectForKey("kCGWindowBounds"));
    windows.push({
      id: w.objectForKey("kCGWindowNumber").js,
      title: String(ObjC.unwrap(w.objectForKey("kCGWindowName")) || ""),
      bounds: { x: b.X, y: b.Y, width: b.Width, height: b.Height },
      alpha: w.objectForKey("kCGWindowAlpha").js,
    });
  }
  return JSON.stringify({
    owner: {
      name: ownerName,
      processId: pid,
      path: String(app.bundleURL.path.js || ""),
      bundleId: String(app.bundleIdentifier.js || ""),
    },
    self: pid === $.getppid(),
    windows,
  });
}`;

function decodeLookup(text: string): Lookup | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const owner = value.owner as Record<string, unknown> | undefined;
  if (!owner || typeof owner.name !== "string" || typeof owner.processId !== "number" || typeof owner.path !== "string" || typeof owner.bundleId !== "string") return null;
  if (!Array.isArray(value.windows)) return null;
  const windows: LookupWindow[] = [];
  for (const entry of value.windows) {
    const w = entry as Record<string, unknown>;
    const b = w?.bounds as Record<string, unknown> | undefined;
    if (!w || typeof w.id !== "number" || typeof w.title !== "string" || typeof w.alpha !== "number" || !b) return null;
    if (![b.x, b.y, b.width, b.height].every((n) => typeof n === "number")) return null;
    windows.push({ id: w.id, title: w.title, alpha: w.alpha, bounds: { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number } });
  }
  return { owner: { name: owner.name, processId: owner.processId, path: owner.path, bundleId: owner.bundleId }, self: value.self === true, windows };
}

/** macActiveWindow's pick from a lookup's JSON line; `self` when the frontmost app is this one. */
export function pickActiveWindow(output: string): ActiveWindow | "self" | undefined {
  const text = output.trim();
  if (!text) return undefined;
  const lookup = decodeLookup(text);
  if (!lookup) return undefined;
  if (lookup.self) return "self";
  const visible = lookup.windows.filter((window) => window.alpha > 0 && window.bounds.width > 0 && window.bounds.height > 0);
  // Helpers belong to the content behind them, which may not be the app's largest window.
  const window = visible.find((candidate, index) => {
    if (candidate.title.trim() !== "") return true;
    const bounds = candidate.bounds;
    return !visible.some((reference, referenceIndex) => {
      if (referenceIndex <= index) return false;
      return (
        (bounds.x === reference.bounds.x &&
          bounds.width === reference.bounds.width &&
          bounds.y <= reference.bounds.y &&
          reference.bounds.y - bounds.y <= reference.bounds.height * MAC_HELPER_STRIP_MAX_THICKNESS_RATIO &&
          bounds.height <= bounds.width * MAC_HELPER_STRIP_MAX_THICKNESS_RATIO &&
          bounds.height <= reference.bounds.height * MAC_HELPER_STRIP_MAX_THICKNESS_RATIO) ||
        (bounds.y === reference.bounds.y &&
          bounds.height === reference.bounds.height &&
          bounds.x <= reference.bounds.x &&
          reference.bounds.x - bounds.x <= reference.bounds.width * MAC_HELPER_STRIP_MAX_THICKNESS_RATIO &&
          bounds.width <= bounds.height * MAC_HELPER_STRIP_MAX_THICKNESS_RATIO &&
          bounds.width <= reference.bounds.width * MAC_HELPER_STRIP_MAX_THICKNESS_RATIO)
      );
    });
  });
  if (!window) return undefined;
  return {
    platform: "macos",
    id: window.id,
    title: window.title,
    bounds: window.bounds,
    owner: {
      name: lookup.owner.name,
      processId: lookup.owner.processId,
      path: lookup.owner.path,
      ...(lookup.owner.bundleId ? { bundleId: lookup.owner.bundleId } : {}),
    },
  };
}

/** activeWindow("darwin"). Resolves undefined when the lookup fails. */
export async function activeMacWindow(): Promise<ActiveWindow | "self" | undefined> {
  try {
    const output = await desktop().run("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_ACTIVE_WINDOW_SCRIPT], { timeoutMs: MAC_LOOKUP_TIMEOUT_MS });
    return output.code === 0 ? pickActiveWindow(output.stdout) : undefined;
  } catch {
    return undefined;
  }
}

/** The JXA that answers whether this process is trusted for Accessibility (osascript runs as this app's child, so TCC asks
 * about this app): Electron's systemPreferences.isTrustedAccessibilityClient(false). */
export const MAC_ACCESSIBILITY_TRUSTED_SCRIPT = `ObjC.import("ApplicationServices"); function run() { return $.AXIsProcessTrusted() ? "true" : "false"; }`;

/** isTrustedAccessibilityClient(false); false when it cannot be asked. */
export async function accessibilityTrusted(): Promise<boolean> {
  // The host's own AXIsProcessTrusted (host patch 0018 `ax.trusted`), as Electron asks in its main process; osascript's
  // answer is its responsible process's, which is the launcher's (a terminal) for an app not started from its bundle.
  try {
    if (host.available()) { const own = await host.call("ax.trusted", null, { timeout: 2_000 }); if (typeof own === "boolean") return own; }
  } catch { /* an older host: ask through osascript */ }
  try {
    const output = await desktop().run("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_ACCESSIBILITY_TRUSTED_SCRIPT], { timeoutMs: MAC_LOOKUP_TIMEOUT_MS });
    return output.code === 0 && output.stdout.trim() === "true";
  } catch {
    return false;
  }
}
