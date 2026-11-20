// SnapShotCoordinator.tsx: a capture lands in the current draft. The port captures the frontmost window, or the one the user
// picks when the frontmost app is R3 Code (desktop/snapShot.ts captureWindow), writes it to the pending SnapShot queue
// (snapShotQueue.ts, as the reference's DesktopSnapShot.ts persists a capture before anything reads it), then hands it to
// the composer's own attachment intake (store.ts addAttachmentPath) exactly as a file attached from disk, and acknowledges
// (removes) the queue entry only once that attach lands. A failed attach leaves the entry queued — `drainPendingSnapShots`
// retries it (on the next capture, or once at startup) instead of losing the capture, as a synchronous always-unlink would.
import { readFile } from "fs/promises";
import { showToast } from "../components/toast/toastState";
import { addAttachmentPath } from "../store";
import { desktop } from "./runtime";
import { markSnapShotCapture } from "./snapShotArrival";
import { showSnapShotFlash } from "./snapShotFlash";
import { emitSnapShotEvent, acknowledgeSnapShot, listPendingSnapShots, pendingCapturePngPath, writePendingCapture, type SnapShotQueueSource } from "./snapShotQueue";
import { probeSnapShotSource, recordSnapShotSource, snapShotWireSource, type SnapShotSource } from "./snapShotSource";
import { pngSize } from "./snapShotAccessibility";
import { captureWindow, lastCapturedWindow, openMacPermissionSettings, playSnapShotSound, refreshSnapShotState, snapShotSettings, type CaptureResult } from "./snapShot";

export interface CaptureDeps {
  capture: () => Promise<CaptureResult>;
  attach: (path: string, extra?: { source?: unknown }) => Promise<void>;
  /** The captured PNG's pixel size (the accessibility tree's coordinate space). */
  imageSize: (path: string) => Promise<{ width: number; height: number } | null>;
  playSound: typeof playSnapShotSound;
  /** Finds the captured window's app, title and text (snapShotSource.ts). */
  probe: () => Promise<SnapShotSource | null>;
  toast: typeof showToast;
  randomId: () => string;
  /** The window's own feedback flash (snapShotFlash.ts); never blocks or fails a capture. */
  flash: typeof showSnapShotFlash;
}

const readPngSize = async (path: string) => { try { return pngSize(new Uint8Array(await readFile(path))); } catch { return null; } };
const defaultDeps: CaptureDeps = {
  capture: captureWindow,
  attach: addAttachmentPath,
  imageSize: readPngSize,
  playSound: playSnapShotSound,
  probe: () => probeSnapShotSource(lastCapturedWindow?.id),
  toast: showToast,
  randomId: () => desktop().randomId(),
  flash: showSnapShotFlash,
};
let deps = defaultDeps;

/** Tests swap the capture, the intake and the toasts. */
export function configureSnapShotCapture(next: Partial<CaptureDeps>) {
  deps = { ...deps, ...next };
}

let capturing = false;

/** What a capture ended as, for tests and callers that care. */
export type CaptureOutcome = "attached" | "cancelled" | "denied" | "failed" | "busy" | "disabled";

const fallbackSource = (capturedAt: string): SnapShotQueueSource => ({ kind: "snap-shot", capturedAt, appName: "Window", windowTitle: "" });

/** Attaches one already-queued capture to the current draft and acknowledges it on success (SnapShotCoordinator.tsx
 * `deliverSnapShot`, minus the multi-thread targeting the port's single current draft has no use for). Left pending,
 * and reported, on failure. */
async function deliverPendingCapture(id: string, pngPath: string, source: SnapShotQueueSource): Promise<boolean> {
  try {
    await deps.attach(pngPath, { source });
    await acknowledgeSnapShot(id);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Try the capture again.";
    if (/open a thread/i.test(message)) {
      deps.toast({ type: "error", title: "Snapshot taken, but no project is available", description: "Add a project, then capture the window again." });
    } else {
      deps.toast({ type: "error", title: "Snapshot failed", description: message });
    }
    emitSnapShotEvent({ type: "failed", id });
    return false;
  }
}

/** Retries queue entries a previous capture left pending (a failed attach, or the app quitting between "ready" and
 * attach): called once at startup, and SnapShot being this app's only writer to its own queue, also safe to call
 * before a fresh capture. An entry whose PNG is already gone cannot be delivered, so it is just cleared. */
export async function drainPendingSnapShots(): Promise<void> {
  for (const pending of await listPendingSnapShots()) {
    const pngPath = await pendingCapturePngPath(pending.id);
    if (!pngPath) {
      await acknowledgeSnapShot(pending.id).catch(() => undefined);
      continue;
    }
    await deliverPendingCapture(pending.id, pngPath, pending.source);
  }
}

/** Captures a window and attaches it to the current draft. */
export async function captureSnapShotToDraft(): Promise<CaptureOutcome> {
  const settings = snapShotSettings();
  if (!settings.snapShotEnabled) return "disabled";
  if (capturing) return "busy";
  capturing = true;
  const id = deps.randomId();
  try {
    emitSnapShotEvent({ type: "requested", id });
    if (settings.snapShotPlaySound) void deps.playSound(settings.snapShotSound);
    const result = await deps.capture();
    if (result.status === "cancelled") return "cancelled";
    if (result.status === "denied") {
      emitSnapShotEvent({ type: "failed", id });
      void refreshSnapShotState().catch(() => undefined);
      deps.toast({
        type: "error",
        title: "Snapshot failed",
        description: result.message,
        actions: [{ label: "Open System Settings", run: () => void openMacPermissionSettings("screen-recording") }],
      });
      return "denied";
    }
    if (result.status === "failed") {
      emitSnapShotEvent({ type: "failed", id });
      deps.toast({ type: "error", title: "Snapshot failed", description: result.message || "Try the capture again." });
      return "failed";
    }
    emitSnapShotEvent({ type: "started", id });
    if (settings.snapShotFlash) {
      const bounds = lastCapturedWindow?.bounds;
      if (bounds) void deps.flash({ bounds, animated: settings.snapShotAnimations });
    }
    // The tile the composer draws for this file is a SnapShot tile (snapShotArrival.ts).
    const captureName = result.path.split("/").pop() ?? result.path;
    markSnapShotCapture(captureName, result.capturedAt);
    // Ask which window that was (by id, or the one still under the pointer that picked it). As the reference's capture, the
    // window's source (app, title, accessibility) travels with the image (ChatImageAttachment.source), so it is read first.
    const source = await deps.probe().catch(() => null);
    let wire: SnapShotQueueSource | undefined;
    if (source) {
      const size = source.rawTree ? await deps.imageSize(result.path) : null;
      wire = snapShotWireSource(source, result.capturedAt, size, settings.snapShotIncludeAccessibility !== false) as SnapShotQueueSource;
      recordSnapShotSource(captureName, source);
    }
    const queuedSource = wire ?? fallbackSource(result.capturedAt);
    try {
      await writePendingCapture(id, { pngPath: result.path, name: captureName, sizeBytes: result.sizeBytes, source: queuedSource });
    } catch (error) {
      emitSnapShotEvent({ type: "failed", id });
      deps.toast({ type: "error", title: "Snapshot failed", description: error instanceof Error ? error.message : "Try the capture again." });
      return "failed";
    }
    emitSnapShotEvent({ type: "ready", id });
    return (await deliverPendingCapture(id, result.path, queuedSource)) ? "attached" : "failed";
  } finally {
    capturing = false;
  }
}
