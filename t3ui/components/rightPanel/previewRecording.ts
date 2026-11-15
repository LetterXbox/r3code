// The browser tab's capture button (PreviewChromeRow.tsx Camera; PreviewView.tsx handleCapture; browserRecording.ts):
// a press saves a screenshot of the page, Shift+press starts recording it, a press while recording stops and saves the
// video. Files go to `<dataDir>/preview-artifacts` (PreviewManager artifactDirectory) as
// `browser-screenshot-<id>.png` / `browser-recording-<id>.mp4`. The pixels come from the host: `webview.capture`
// (patch 0015) and `webview.recordStart` / `webview.recordStop` (patch 0016), the page's own snapshots, so no
// Screen Recording grant is asked. A host without them rejects, and the press says why.
import { Clipboard, host, signal, token } from "nsh";
import { desktop } from "../../desktop/runtime";
import { requestBackend, settingValue } from "../../store";
import { parseColor } from "../composer/tokenColor";
import { revealLabel } from "../files/fileActions";
import { showToast, updateToast } from "../toast/toastState";
import { captureFailureDescription } from "./captureErrors";
import type { RecordingInputOptions } from "./recordingInput";
import { DEFAULT_RECORDING_INPUT_OPTIONS } from "./recordingInput";
import { INSTALL_PREVIEW_RECORDING_SOURCE } from "./previewRecordingPage.generated";

export interface RecordingArtifact { path: string; mimeType: string; sizeBytes: number }
type HostCall = (name: string, data: unknown) => Promise<unknown>;

/** The tabs (surface ids) recording now (useActiveBrowserRecordingTabIds). */
const active = signal<Readonly<Record<string, { path: string; startedAt: string }>>>({});
export const activeRecordingTabIds = (): ReadonlySet<string> => new Set(Object.keys(active()));
export const isTabRecording = (surfaceId: string) => active()[surfaceId] !== undefined;

/** browserRecordingShowKeyPresses / browserRecordingShowMousePresses (Settings > Browser > Recordings). */
export function recordingInputOptions(read: (key: string) => unknown = settingValue as never): RecordingInputOptions {
  return { showKeyPresses: read("browserRecordingShowKeyPresses") === true, showMousePresses: read("browserRecordingShowMousePresses") === true };
}

/** The app's `primary` token as 0..1 floats: the host draws the ring itself and must not parse CSS. */
export function recordingPrimaryColor(read: (name: Parameters<typeof token>[0]) => unknown = token): { r: number; g: number; b: number; a: number } {
  const rgb = parseColor(String(read("primary")));
  return rgb ? { r: rgb[0] / 255, g: rgb[1] / 255, b: rgb[2] / 255, a: 1 } : { r: 0.145, g: 0.388, b: 0.922, a: 1 };
}

/** The script that installs (or, run again, replaces) the recording cursor in the page (previewRecordingPage.ts). */
export function recordingCursorScript(options: RecordingInputOptions, primary: string): string {
  const cfg = JSON.stringify({ showKeyPresses: options.showKeyPresses, showMousePresses: options.showMousePresses, primary }).replace(/</g, "\\u003c");
  return `(${INSTALL_PREVIEW_RECORDING_SOURCE})(${cfg},{window:window,document:document});true;`;
}

/** The page's `{t3:"recordingInput"}` message (DesktopPreviewRecordingInput), or null when it is not a valid one. */
export function parseRecordingInputMessage(data: string): { type: "clear" } | { type: "key"; label: string | null; held: boolean; width: number } | { type: "pointer"; phase: "move" | "down" | "up" | "click"; x: number; y: number; width: number; height: number } | null {
  let m: { t3?: unknown; input?: unknown };
  try { m = JSON.parse(data); } catch { return null; }
  if (m?.t3 !== "recordingInput") return null;
  const input = m.input as Record<string, unknown> | undefined;
  if (!input || typeof input.type !== "string") return null;
  if (input.type === "clear") return { type: "clear" };
  if (input.type === "key" && (input.label === null || typeof input.label === "string") && typeof input.held === "boolean" && typeof input.width === "number") {
    return { type: "key", label: input.label as string | null, held: input.held, width: input.width };
  }
  if (input.type === "pointer" && ["move", "down", "up", "click"].includes(input.phase as string) && typeof input.x === "number" && typeof input.y === "number" && typeof input.width === "number" && typeof input.height === "number") {
    return { type: "pointer", phase: input.phase as "move" | "down" | "up" | "click", x: input.x, y: input.y, width: input.width, height: input.height };
  }
  return null;
}

/** The browser tab injects the recording cursor script and forwards its page messages (RightPanel's surfaces.tsx); returns the release. */
const injectors = new Map<string, (script: string) => void>();
const unsupported = new Set<string>();
export function registerTabRecordingInjector(surfaceId: string, inject: (script: string) => void): () => void {
  injectors.set(surfaceId, inject);
  return () => { if (injectors.get(surfaceId) === inject) injectors.delete(surfaceId); };
}

/** Forwards a page's `{t3:"recordingInput"}` message to the host's `webview.recordInput` (patch 0017) while the tab
 * records and the host supports it; a host without it rejects once, and no further call is made for this recording
 * (every pointer move while dragging would otherwise reject one at a time). */
export async function forwardRecordingInput(surfaceId: string, input: object, call: HostCall = (n, d) => host.call(n, d)): Promise<void> {
  if (!active()[surfaceId] || unsupported.has(surfaceId)) return;
  try {
    await call("webview.recordInput", input);
  } catch {
    unsupported.add(surfaceId);
  }
}

export function artifactDirectory(dataDir: string | null = desktop().dataDir()): string | null {
  return dataDir ? `${dataDir.replace(/\/+$/, "")}/preview-artifacts` : null;
}

/** browserRecordingFrameRate (Settings > Browser): 30 or 60. */
export const recordingFrameRate = (read: (key: string) => unknown = settingValue as never): 30 | 60 => (read("browserRecordingFrameRate") === 60 ? 60 : 30);

const artifactId = (kind: "screenshot" | "recording") => `browser-${kind}-${Date.now().toString(36)}`;

/** startBrowserRecording: one recording at a time (BrowserRecordingConflictError). */
export async function startTabRecording(surfaceId: string, point: { x: number; y: number } | null, call: HostCall = (n, d) => host.call(n, d)): Promise<void> {
  if (active()[surfaceId]) return;
  if (Object.keys(active()).length > 0) throw new Error("Another browser tab is already recording. Stop it before starting a new recording.");
  const dir = artifactDirectory();
  if (!dir) throw new Error("This app has no data folder to save the recording in.");
  await desktop().mkdir(dir);
  const path = `${dir}/${artifactId("recording")}.mp4`;
  const options = recordingInputOptions();
  const primary = recordingPrimaryColor();
  await call("webview.recordStart", {
    path, frameRate: recordingFrameRate(), ...(point ? { point } : {}),
    ...(options.showKeyPresses || options.showMousePresses ? { decorations: { showKeyPresses: options.showKeyPresses, showMousePresses: options.showMousePresses, primaryColor: primary } } : {}),
  });
  active.update((all) => ({ ...all, [surfaceId]: { path, startedAt: new Date().toISOString() } }));
  unsupported.delete(surfaceId);
  // The DOM cursor installs regardless (it hides the page's native one); only the emits it posts are gated on the options.
  injectors.get(surfaceId)?.(recordingCursorScript(options, String(token("primary"))));
}

/** stopBrowserRecording: resolves the saved file, null when the tab was not recording. */
export async function stopTabRecording(surfaceId: string, call: HostCall = (n, d) => host.call(n, d)): Promise<RecordingArtifact | null> {
  if (!active()[surfaceId]) return null;
  try {
    const result = (await call("webview.recordStop", null)) as Partial<RecordingArtifact> | null;
    if (!result || typeof result.path !== "string") throw new Error("The recording could not be saved.");
    return { path: result.path, mimeType: typeof result.mimeType === "string" ? result.mimeType : "video/mp4", sizeBytes: typeof result.sizeBytes === "number" ? result.sizeBytes : 0 };
  } finally {
    active.update((all) => { const next = { ...all }; delete next[surfaceId]; return next; });
    unsupported.delete(surfaceId);
    injectors.get(surfaceId)?.(RECORDING_CURSOR_DISPOSE_SCRIPT);
  }
}

/** Run when a tab stops recording, or loses the page it was recording (navigation, close). */
export const RECORDING_CURSOR_DISPOSE_SCRIPT = "window.__t3record && window.__t3record.dispose(); true;";

/** bridge.captureScreenshot: the page as a PNG in the artifact folder. */
export async function captureTabScreenshot(point: { x: number; y: number } | null, call: HostCall = (n, d) => host.call(n, d)): Promise<{ path: string; dataUrl: string }> {
  const result = (await call("webview.capture", point ? { point } : {})) as { dataUrl?: unknown } | null;
  const dataUrl = typeof result?.dataUrl === "string" ? result.dataUrl : "";
  if (!dataUrl.startsWith("data:image/png;base64,")) throw new Error("The page could not be captured.");
  const dir = artifactDirectory();
  if (!dir) throw new Error("This app has no data folder to save the screenshot in.");
  await desktop().mkdir(dir);
  const path = `${dir}/${artifactId("screenshot")}.png`;
  await desktop().writeFile(path, Uint8Array.from(atob(dataUrl.slice("data:image/png;base64,".length)), (c) => c.charCodeAt(0)));
  return { path, dataUrl };
}

const reveal = (path: string) => void requestBackend("shell.openInEditor", { cwd: path, editor: "file-manager", reveal: true }).catch(() => undefined);
const revealText = () => revealLabel({ os: desktop().os(), editors: [], canReveal: true, revealKind: desktop().os() === "macos" ? "finder" : desktop().os() === "windows" ? "file-explorer" : "files" });

/** handleCapture's toasts: "Recording saved" / "Screenshot saved" with Reveal and Copy path (and Copy image), each
 * copy button reading "Copied!" for 2 s; failures say "Unable to copy ..." in place. */
function savedToast(kind: "recording" | "screenshot", path: string, dataUrl?: string) {
  const title = kind === "recording" ? "Recording saved" : "Screenshot saved";
  let pathCopied = false, imageCopied = false;
  let id = "";
  const render = () => ({
    type: "success" as const, title, timeoutMs: 0,
    actions: [
      ...(dataUrl ? [{ label: imageCopied ? "Copied!" : "Copy image", disabled: imageCopied, variant: "outline" as const, run: () => copy("image") }] : []),
      { label: pathCopied ? "Copied!" : "Copy path", disabled: pathCopied, variant: "outline" as const, run: () => copy("path") },
      { label: revealText(), run: () => reveal(path) },
    ],
  });
  const copy = (what: "path" | "image") => {
    const done = what === "path" ? Clipboard.writeText(path) : Clipboard.writeImage(dataUrl!);
    void Promise.resolve(done).then(() => {
      if (what === "path") pathCopied = true; else imageCopied = true;
      updateToast(id, render());
      setTimeout(() => { if (what === "path") pathCopied = false; else imageCopied = false; updateToast(id, render()); }, 2000);
    }, (error: unknown) => {
      updateToast(id, { type: "error", title: what === "path" ? `Unable to copy ${kind} path` : "Unable to copy screenshot", description: error instanceof Error ? error.message : "An error occurred.", actions: [{ label: revealText(), run: () => reveal(path) }] });
    });
  };
  id = showToast(render());
}

/** handleCapture(record): stop when recording; else record (Shift) or take a screenshot. */
export function handleTabCapture(surfaceId: string, record: boolean, point: { x: number; y: number } | null): void {
  if (isTabRecording(surfaceId)) {
    void stopTabRecording(surfaceId).then((artifact) => { if (artifact) savedToast("recording", artifact.path); },
      (error: unknown) => showToast({ type: "error", title: "Unable to stop recording", description: error instanceof Error ? error.message : "An error occurred." }));
    return;
  }
  if (record) {
    void startTabRecording(surfaceId, point).catch((error: unknown) => showToast({ type: "error", title: "Unable to start recording", description: captureFailureDescription(error, "recording-start") }));
    return;
  }
  void captureTabScreenshot(point).then(({ path, dataUrl }) => savedToast("screenshot", path, dataUrl),
    (error: unknown) => showToast({ type: "error", title: "Unable to capture screenshot", description: captureFailureDescription(error, "screenshot") }));
}
