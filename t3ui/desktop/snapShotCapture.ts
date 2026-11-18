// SnapShotCoordinator.tsx: a capture lands in the current draft. The port captures the frontmost window, or the one the user
// picks when the frontmost app is R3 Code (desktop/snapShot.ts captureWindow), then hands the PNG to the composer's own attachment intake (store.ts
// addAttachmentPath), exactly as a file attached from disk, and removes the temporary file.
import { readFile } from "fs/promises";
import { showToast } from "../components/toast/toastState";
import { addAttachmentPath } from "../store";
import { desktop } from "./runtime";
import { markSnapShotCapture } from "./snapShotArrival";
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
}

const readPngSize = async (path: string) => { try { return pngSize(new Uint8Array(await readFile(path))); } catch { return null; } };
const defaultDeps: CaptureDeps = { capture: captureWindow, attach: addAttachmentPath, imageSize: readPngSize, playSound: playSnapShotSound, probe: () => probeSnapShotSource(lastCapturedWindow?.id), toast: showToast };
let deps = defaultDeps;

/** Tests swap the capture, the intake and the toasts. */
export function configureSnapShotCapture(next: Partial<CaptureDeps>) {
  deps = { ...deps, ...next };
}

let capturing = false;

/** What a capture ended as, for tests and callers that care. */
export type CaptureOutcome = "attached" | "cancelled" | "denied" | "failed" | "busy" | "disabled";

/** Captures a window and attaches it to the current draft. */
export async function captureSnapShotToDraft(): Promise<CaptureOutcome> {
  const settings = snapShotSettings();
  if (!settings.snapShotEnabled) return "disabled";
  if (capturing) return "busy";
  capturing = true;
  try {
    if (settings.snapShotPlaySound) void deps.playSound(settings.snapShotSound);
    const result = await deps.capture();
    if (result.status === "cancelled") return "cancelled";
    if (result.status === "denied") {
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
      deps.toast({ type: "error", title: "Snapshot failed", description: result.message || "Try the capture again." });
      return "failed";
    }
    // The tile the composer draws for this file is a SnapShot tile (snapShotArrival.ts).
    const captureName = result.path.split("/").pop() ?? result.path;
    markSnapShotCapture(captureName, result.capturedAt);
    // Ask which window that was (by id, or the one still under the pointer that picked it). As the reference's capture, the
    // window's source (app, title, accessibility) travels with the image (ChatImageAttachment.source), so it is read first.
    const source = await deps.probe().catch(() => null);
    let wire: unknown;
    if (source) {
      const size = source.rawTree ? await deps.imageSize(result.path) : null;
      wire = snapShotWireSource(source, result.capturedAt, size, settings.snapShotIncludeAccessibility !== false);
      recordSnapShotSource(captureName, source);
    }
    try {
      await deps.attach(result.path, wire ? { source: wire } : {});
    } catch (error) {
      const message = error instanceof Error ? error.message : "Try the capture again.";
      if (/open a thread/i.test(message)) {
        deps.toast({ type: "error", title: "Snapshot taken, but no project is available", description: "Add a project, then capture the window again." });
      } else {
        deps.toast({ type: "error", title: "Snapshot failed", description: message });
      }
      return "failed";
    } finally {
      await desktop().unlink(result.path).catch(() => undefined);
    }
    return "attached";
  } finally {
    capturing = false;
  }
}
