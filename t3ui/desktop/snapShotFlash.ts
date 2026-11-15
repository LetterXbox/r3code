// desktop/snapShot.ts's "Capture flash" setting (snapShotFlash; reference DesktopSnapShot.ts:607-675,693-722's
// SnapShotFlash / showCaptureFeedback): a brief white overlay over the captured window, fading out when
// `snapShotAnimations` is also on, shown once then dismissed.
//
// NSH has no API to put a second, borderless, always-on-top window over another app's window (the port's own
// window is the only surface it can draw into: see snapShotArrival.ts's note on the fly-in transition, dropped for
// the same reason). So this is capability-gated through the GPUI host the same way desktop/desktopHost.ts's other
// calls are: `desktop.capabilities` lists `snapshot.flash` only once the host understands it, and the setting
// degrades to a no-op (the toggle disables itself: SnapShotSettings.logic.ts snapShotFeedbackUnavailableMessage)
// until a host that implements it ships. The call this makes, and the patch that would add it, are written as a
// pair: third_party/nsh-host-patches/0022-gpui-snapshot-flash-overlay.patch. THAT PATCH IS UNBUILT AND UNVERIFIED —
// written without the vendored GPUI source tree in this checkout, so its Rust is a draft, not a buildable diff.
import { host } from "nsh";
import { desktopHostCapabilities } from "./desktopHost";

export const SNAP_SHOT_FLASH_CAPABILITY = "snapshot.flash";

export interface SnapShotFlashBounds { x: number; y: number; width: number; height: number }

export interface SnapShotFlashRequest {
  bounds: SnapShotFlashBounds;
  /** Fades out over DesktopSnapShot.ts's FLASH_ANIMATION_DURATION_MS when true, a flat FLASH_STATIC_DURATION_MS
   * flash otherwise (settings.snapShotAnimations, same split as showCaptureFeedback). */
  animated: boolean;
}

/** Whether a host the user is running understands `snapshot.flash` (the SnapShotSettings.tsx toggle's gate). */
export async function snapShotFlashAvailable(): Promise<boolean> {
  return (await desktopHostCapabilities()).has(SNAP_SHOT_FLASH_CAPABILITY);
}

/** Asks the host to flash `bounds`; a false result (no capability, or the call failed) is a silent no-op — the
 * flash is a nicety, never a reason to fail a capture. */
export async function showSnapShotFlash(request: SnapShotFlashRequest): Promise<boolean> {
  if (!(await snapShotFlashAvailable())) return false;
  try {
    await host.call(SNAP_SHOT_FLASH_CAPABILITY, request, { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
