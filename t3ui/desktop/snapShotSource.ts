// What a SnapShot knows about the window it captured (packages/contracts chatAttachment.ts SnapShotSource): the app's icon and
// name, the window's title and the readable accessibility text. `screencapture -i -w` reports none of these, so after a capture
// a short JXA script (osascript, through `process.run`) finds the window under the pointer (the click that picked it) with
// CGWindowList, and, when the app is trusted for Accessibility, reads the window's AX tree as flat text. The overlay bar and the
// accessibility popover on the SnapShot tile (components/thread/SnapShotDetails.tsx) read it.
import { host, signal } from "nsh";
import { desktop } from "./runtime";
import { snapShotAccessibilityFromRaw, type Bounds, type RawAccessibilityElement, type SnapShotAccessibility } from "./snapShotAccessibility";

export interface SnapShotSource {
  appName: string;
  windowTitle: string;
  /** A `data:image/png;base64,` icon, at most 100,000 characters. */
  appIconDataUrl?: string;
  appIdentifier?: string;
  /** The window's readable text, one element per line (the `flat-text` accessibility format). */
  accessibleText?: string;
  /** The AX tree was cut short. */
  truncated?: boolean;
  /** The probe's raw element tree (screen points) and the frame to map it with (snapShotAccessibility.ts). */
  rawTree?: RawAccessibilityElement;
  rawTreeTruncated?: boolean;
  windowFrame?: Bounds;
  /** The captured window's owner and CGWindow number, for the host's in-process AX read (ax.windowTree). */
  pid?: number;
  windowNumber?: number;
  /** The structured accessibility sent with the capture, once mapped to the captured image. */
  accessibility?: SnapShotAccessibility;
}

export const SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS = 20_000;
const ICON_MAX_CHARS = 100_000;

/** The reference's snapShotAccessibilityDetails: the readable text (the element tree's names and values, or the flat text). */
export function snapShotAccessibilityDetails(source: SnapShotSource): { content: string; format: "text" } | undefined {
  const text = source.accessibleText?.trim();
  return text ? { content: text, format: "text" } : undefined;
}

/** snapShotIncludesAccessibility: flat text, or a structured tree (even one with no readable names). */
export const snapShotIncludesAccessibility = (source: SnapShotSource): boolean => Boolean(source.accessibleText?.trim()) || source.accessibility?.format === "element-tree";

/** The overlay's second line: the window title, or "Captured window". */
export const snapShotWindowLabel = (source: SnapShotSource): string => source.windowTitle || "Captured window";

/** The popover's body copy for a source: the data, or why there is none (SnapShotContentsButton's three states). */
export function snapShotAccessibilityNotice(source: SnapShotSource): string | null {
  if (snapShotAccessibilityDetails(source)) return null;
  return snapShotIncludesAccessibility(source)
    ? "Structured accessibility elements were included, but they have no readable names or values."
    : "The app or capture backend did not provide verified accessibility data.";
}

function frameOf(value: unknown): Bounds | null {
  if (!value || typeof value !== "object") return null;
  const b = value as Record<string, unknown>;
  const f = { x: Number(b.x), y: Number(b.y), width: Number(b.width), height: Number(b.height) };
  return [f.x, f.y, f.width, f.height].every(Number.isFinite) && f.width > 0 && f.height > 0 ? f : null;
}

/** The probe's JSON line as a source; null when the pointer was over no window. */
export function parseSnapShotProbe(stdout: string): SnapShotSource | null {
  let raw: Record<string, unknown> | null;
  try { raw = JSON.parse(stdout.trim()) as Record<string, unknown> | null; } catch { return null; }
  if (!raw || typeof raw !== "object" || typeof raw.appName !== "string" || raw.appName.trim() === "") return null;
  const icon = typeof raw.appIconDataUrl === "string" && /^data:image\/png;base64,/i.test(raw.appIconDataUrl) && raw.appIconDataUrl.length <= ICON_MAX_CHARS ? raw.appIconDataUrl : undefined;
  const windowFrame = frameOf(raw.windowFrame) ?? frameOf(raw.cgBounds);
  const text = typeof raw.accessibleText === "string" ? raw.accessibleText.trim().slice(0, SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS) : "";
  return {
    appName: raw.appName.trim().slice(0, 255),
    windowTitle: typeof raw.windowTitle === "string" ? raw.windowTitle.trim().slice(0, 1_000) : "",
    ...(icon ? { appIconDataUrl: icon } : {}),
    ...(typeof raw.appIdentifier === "string" && raw.appIdentifier.trim() ? { appIdentifier: raw.appIdentifier.trim().slice(0, 255) } : {}),
    ...(text ? { accessibleText: text } : {}),
    ...(raw.truncated === true ? { truncated: true } : {}),
    ...(raw.tree && typeof raw.tree === "object" ? { rawTree: raw.tree as RawAccessibilityElement, rawTreeTruncated: raw.treeTruncated === true } : {}),
    ...(windowFrame ? { windowFrame } : {}),
    ...(typeof raw.pid === "number" && Number.isFinite(raw.pid) ? { pid: raw.pid } : {}),
    ...(typeof raw.windowNumber === "number" && Number.isFinite(raw.windowNumber) ? { windowNumber: raw.windowNumber } : {}),
  };
}

/** The JXA the probe runs: the window under the pointer, its app's icon (32pt), and, when trusted, the window's AX text. */
export const SNAP_SHOT_PROBE_SCRIPT = `
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
ObjC.import("ApplicationServices");
function attr(el, name) { const out = Ref(); return $.AXUIElementCopyAttributeValue(el, $(name), out) === 0 ? out[0] : null; }
function str(el, name) {
  const v = attr(el, name);
  if (v === null) return null;
  const o = ObjC.castRefToObject(v);
  if (!o || !o.isKindOfClass($.NSString)) return null;
  const s = ObjC.unwrap(o).trim();
  return s.length > 0 ? s : null;
}
function readText(pid, title) {
  if (!$.AXIsProcessTrusted()) return null;
  const wins = attr($.AXUIElementCreateApplication(pid), "AXWindows");
  if (!wins) return null;
  const list = ObjC.castRefToObject(wins);
  let win = null;
  for (let i = 0; i < list.count; i++) { const w = list.objectAtIndex(i); if (win === null) win = w; if (str(w, "AXTitle") === title) { win = w; break; } }
  // The JXA bridge hands child AX elements back as the application element (seen 2026-11-13): no window, no text then.
  if (win === null || str(win, "AXRole") !== "AXWindow") return null;
  const lines = []; let count = 0; let chars = 0; let cut = false; let nodes = 0; const started = Date.now();
  function walk(el, depth) {
    if (count >= 600 || chars >= ${SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS}) { cut = true; return; }
    if (depth > 12) { cut = true; return; }
    count++;
    const role = (str(el, "AXRole") || "").replace(/^AX/, "");
    const name = str(el, "AXTitle") || str(el, "AXDescription");
    const value = str(el, "AXValue");
    if (name || value) { const line = "  ".repeat(Math.min(depth, 8)) + role + (name ? ": " + name : "") + (value && value !== name ? " = " + value.slice(0, 300) : ""); lines.push(line); chars += line.length + 1; }
    const kids = attr(el, "AXChildren");
    if (kids) { const k = ObjC.castRefToObject(kids); for (let i = 0; i < k.count; i++) walk(k.objectAtIndex(i), depth + 1); }
  }
  walk(win, 0);
  // The element tree (SnapShotAccessibility element-tree): role, name, value, description, a few states and the frame in
  // screen points (AXPosition / AXSize read from their AXValue descriptions), bounded by count, depth and a 2.5 s budget.
  function num(el, name) { const v = attr(el, name); if (v === null) return null; try { const o = ObjC.castRefToObject(v); return o && o.isKindOfClass($.NSNumber) ? Boolean(o.boolValue) : null; } catch (e) { return null; } }
  function frame(el) {
    const p = attr(el, "AXPosition"), s = attr(el, "AXSize");
    if (p === null || s === null) return null;
    try {
      const pd = ObjC.unwrap(ObjC.castRefToObject(p).description), sd = ObjC.unwrap(ObjC.castRefToObject(s).description);
      const pm = /x:(-?[\\d.]+) y:(-?[\\d.]+)/.exec(pd), sm = /w:(-?[\\d.]+) h:(-?[\\d.]+)/.exec(sd);
      return pm && sm ? { x: Number(pm[1]), y: Number(pm[2]), width: Number(sm[1]), height: Number(sm[2]) } : null;
    } catch (e) { return null; }
  }
  let treeCut = false;
  function node(el, depth) {
    if (nodes >= 3000 || depth > 24 || Date.now() - started > 2500) { treeCut = true; return null; }
    nodes++;
    const out = { role: str(el, "AXRole"), name: str(el, "AXTitle"), value: str(el, "AXValue"), description: str(el, "AXDescription") || str(el, "AXHelp"), bounds: frame(el), children: [] };
    const focused = num(el, "AXFocused"), enabled = num(el, "AXEnabled"), selected = num(el, "AXSelected"), expanded = num(el, "AXExpanded");
    if (focused === true) out.focused = true;
    if (enabled === false) out.enabled = false;
    if (selected === true) out.selected = true;
    if (expanded !== null) out.expanded = expanded;
    const kids = attr(el, "AXChildren");
    if (kids) { const k = ObjC.castRefToObject(kids); for (let i = 0; i < k.count; i++) { const c = node(k.objectAtIndex(i), depth + 1); if (c === null) break; out.children.push(c); } }
    return out;
  }
  let tree = null;
  try { tree = node(win, 0); } catch (e) { tree = null; }
  return { text: lines.join("\\n"), truncated: cut, tree: tree, treeTruncated: treeCut, windowFrame: frame(win) };
}
function run(argv) {
  try {
    const target = argv && argv.length > 0 ? Number(argv[0]) : NaN;
    const mouse = $.NSEvent.mouseLocation;
    const screenHeight = $.NSScreen.screens.objectAtIndex(0).frame.size.height;
    const x = mouse.x, y = screenHeight - mouse.y;
    const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID)));
    for (const w of list) {
      if (w.kCGWindowLayer !== 0) continue;
      const b = w.kCGWindowBounds;
      if (Number.isFinite(target)) { if (w.kCGWindowNumber !== target) continue; } else if (!(x >= b.X && x <= b.X + b.Width && y >= b.Y && y <= b.Y + b.Height)) continue;
      const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(w.kCGWindowOwnerPID);
      let icon = null;
      let bundle = null;
      if (app) {
        const id = app.bundleIdentifier;
        bundle = id ? ObjC.unwrap(id) : null;
        if (app.icon) {
          const small = $.NSImage.alloc.initWithSize($.NSMakeSize(32, 32));
          small.lockFocus;
          app.icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 32, 32), $.NSZeroRect, 2, 1);
          small.unlockFocus;
          const png = $.NSBitmapImageRep.imageRepWithData(small.TIFFRepresentation).representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
          icon = "data:image/png;base64," + ObjC.unwrap(png.base64EncodedStringWithOptions(0));
        }
      }
      let text = null;
      try { text = readText(w.kCGWindowOwnerPID, w.kCGWindowName || ""); } catch (e) { text = null; }
      return JSON.stringify({ appName: w.kCGWindowOwnerName, windowTitle: w.kCGWindowName || "", appIdentifier: bundle, appIconDataUrl: icon, accessibleText: text ? text.text : null, truncated: text ? text.truncated : false, tree: text ? text.tree : null, treeTruncated: text ? text.treeTruncated : false, windowFrame: text ? text.windowFrame : null, cgBounds: { x: b.X, y: b.Y, width: b.Width, height: b.Height }, pid: w.kCGWindowOwnerPID, windowNumber: w.kCGWindowNumber });
    }
  } catch (e) {}
  return "null";
}
`;

/** Finds the captured window (by id, when the capture took the frontmost window; else the one under the pointer that picked it)
 * and what it shows. Resolves null when anything fails: the tile then has no source bar. */
export async function probeSnapShotSource(windowId?: number): Promise<SnapShotSource | null> {
  try {
    const output = await desktop().run("/usr/bin/osascript", ["-l", "JavaScript", "-e", SNAP_SHOT_PROBE_SCRIPT, ...(windowId === undefined ? [] : [String(windowId)])], { timeoutMs: 8_000 });
    const source = output.code === 0 ? parseSnapShotProbe(output.stdout) : null;
    if (source && source.pid !== undefined) await readHostAccessibility(source);
    return source;
  } catch {
    return null;
  }
}

/** The host's in-process AX read (host patch 0018 `ax.windowTree`): the window's element tree in screen points. A host
 * without it rejects, and the source keeps the probe's flat text (or none). */
async function readHostAccessibility(source: SnapShotSource): Promise<void> {
  try {
    if (!host.available()) return;
    const result = await host.call("ax.windowTree", { pid: source.pid, windowNumber: source.windowNumber, title: source.windowTitle }, { timeout: 4_000 }) as { tree?: unknown; truncated?: unknown; windowFrame?: unknown } | null;
    if (!result || !result.tree || typeof result.tree !== "object") return;
    source.rawTree = result.tree as RawAccessibilityElement;
    source.rawTreeTruncated = result.truncated === true;
    const frame = frameOf(result.windowFrame);
    if (frame) source.windowFrame = frame;
  } catch { /* no host call: keep what the probe read */ }
}

// ---- Sources by capture (the file's name, as snapShotArrival.ts keys captures) ----

const MAX_REMEMBERED = 50;
const sources = signal<Record<string, SnapShotSource>>({});

export function recordSnapShotSource(name: string, source: SnapShotSource): void {
  sources.update((all) => {
    const next = { ...all, [name]: source };
    const names = Object.keys(next);
    for (const old of names.slice(0, Math.max(0, names.length - MAX_REMEMBERED))) delete next[old];
    return next;
  });
}

/** The captured window's source for the attachment `name`, once the probe answered. */
export const snapShotSourceFor = (name: string): SnapShotSource | undefined => sources()[name];

/**
 * contracts SnapShotSource, as the desktop hands it with the capture (DesktopSnapShot.ts + SnapShotAccessibility.ts
 * accessibilityReadSnapshot): the element tree in the image's pixels when the window's AX tree was read, else the flat text.
 * Also sets `accessibility` / `accessibleText` on `source` for the tile's popover. Accessibility is left out when the
 * snapShotIncludeAccessibility setting is off.
 */
export function snapShotWireSource(source: SnapShotSource, capturedAt: string, imageSize: { width: number; height: number } | null, includeAccessibility: boolean): Record<string, unknown> {
  if (includeAccessibility && source.rawTree && imageSize && source.windowFrame) {
    const read = snapShotAccessibilityFromRaw(source.rawTree, source.windowFrame, imageSize, source.rawTreeTruncated === true, SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS);
    if (read?.accessibility) source.accessibility = read.accessibility;
    if (read?.accessibleText) source.accessibleText = read.accessibleText;
  }
  const text = includeAccessibility ? source.accessibleText?.trim() : undefined;
  const accessibility = includeAccessibility
    ? source.accessibility ?? (text ? { format: "flat-text" as const, text, truncated: source.truncated === true || text.length >= SNAP_SHOT_ACCESSIBLE_TEXT_MAX_CHARS } : undefined)
    : undefined;
  return {
    kind: "snap-shot",
    capturedAt,
    appName: source.appName,
    windowTitle: source.windowTitle,
    ...(text ? { accessibleText: text } : {}),
    ...(accessibility ? { accessibility } : {}),
    ...(source.appIdentifier ? { appIdentifier: source.appIdentifier } : {}),
    ...(source.appIconDataUrl ? { appIconDataUrl: source.appIconDataUrl } : {}),
  };
}
