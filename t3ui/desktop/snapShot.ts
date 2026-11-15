// The SnapShot half of the reference's desktop bridge (DesktopBridge getSnapShotState / setupSnapShot /
// requestSnapShotPermissions / checkSnapShotShortcut, apps/desktop/src/snapShot/DesktopSnapShot.ts + MacSnapShot.ts),
// served natively on macOS by /usr/sbin/screencapture through `process.run`.
//
// What NSH can and cannot do here, and so what the state reports:
// - Screen Recording: macOS offers no query an app without native code can make, so the state is what the last capture
//   showed (kept in Storage): granted after a capture wrote an image, not granted after screencapture answered
//   "could not create image", not granted before any capture ran (the wizard's Test capture settles it).
// - Accessibility: AXIsProcessTrusted() asked through osascript (snapShotActiveWindow.ts accessibilityTrusted; the child's TCC
//   answer is this app's), as Electron's isTrustedAccessibilityClient(false); the messages follow macPermissionMessage.
// - Capture: the frontmost app's window by id (screencapture -l, ActiveWindow.ts + MacSnapShot.ts). When the frontmost app is
//   R3 Code itself (the shortcut is app-level only) the user picks the window instead (-i -w).
// - Shortcut: NSH binds app-level keystrokes only (no global hotkeys, no modifier-only bindings), so a key chord is
//   registered in-app (t3ui/commands/snapShotShortcut.ts) and a modifier pair (the default Shift + Shift) is reported
//   unavailable with the reference's own message.
import { keymap, signal } from "nsh";
import { readSetting, writeSetting } from "../pages/settings/settingsSync";
import { desktop, isMac, snapshotsDir } from "./runtime";
import { modifierPairUnavailableMessage, snapShotKeystroke } from "./snapShotShortcut";
import { modifierPairShortcutStatus, probeModifierPairShortcut } from "./snapShotModifierPoller";
import { SNAP_SHOT_CLICK_MP3, SNAP_SHOT_WHOOSH_MP3 } from "./snapShotSounds";
import { accessibilityTrusted, activeMacWindow, type ActiveWindow } from "./snapShotActiveWindow";
import {
  decodeSnapShotShortcut,
  isModifierPairShortcut,
  snapShotShortcutModifierPair,
  type DesktopSnapShotSetupAction,
  type DesktopSnapShotShortcutAvailability,
  type DesktopSnapShotState,
  type SnapShotShortcut,
  type SnapShotSound,
} from "./snapShotTypes";
import { snapShotFlashAvailable } from "./snapShotFlash";

export const SCREENCAPTURE = "/usr/sbin/screencapture";
export const AFPLAY = "/usr/bin/afplay";
const SCREEN_RECORDING_KEY = "t3code:snap-shot-screen-recording:v1";

/** permissions/MacPermission.ts MAC_PERMISSION_SETTINGS_URLS. */
export const MAC_PERMISSION_SETTINGS_URLS = {
  "screen-recording": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "full-disk-access": "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
} as const;

/** DesktopSnapShot.ts MAC_SCREEN_CAPTURE_PERMISSION_MESSAGE. */
export const MAC_SCREEN_CAPTURE_PERMISSION_MESSAGE = "Allow Screen Recording in System Settings, then restart R3 Code.";
/** DesktopSnapShot.ts MAC_ACCESSIBILITY_PERMISSION_MESSAGE / MAC_BOTH_PERMISSIONS_MESSAGE (the app's name as above). */
export const MAC_ACCESSIBILITY_PERMISSION_MESSAGE = "Allow Accessibility in System Settings, then restart R3 Code.";
export const MAC_BOTH_PERMISSIONS_MESSAGE = "Allow Accessibility and Screen Recording in System Settings, then restart R3 Code.";

/** macPermissionMessage. */
export function macPermissionMessage(permissions: { screenRecording: boolean; accessibility: boolean }, includeAccessibility: boolean): string | null {
  const accessibilityGranted = !includeAccessibility || permissions.accessibility;
  if (!accessibilityGranted && !permissions.screenRecording) return MAC_BOTH_PERMISSIONS_MESSAGE;
  if (!accessibilityGranted) return MAC_ACCESSIBILITY_PERMISSION_MESSAGE;
  return permissions.screenRecording ? null : MAC_SCREEN_CAPTURE_PERMISSION_MESSAGE;
}

// --- client settings (contracts settings.ts defaults) ---------------------------------------------------------------

export interface SnapShotSettings {
  snapShotEnabled: boolean;
  snapShotIncludeAccessibility: boolean;
  snapShotShortcut: SnapShotShortcut;
  snapShotPlaySound: boolean;
  snapShotSound: SnapShotSound;
  snapShotFlash: boolean;
  snapShotAnimations: boolean;
}

const bool = (field: string, fallback: boolean) => {
  const value = readSetting(field, "client");
  return typeof value === "boolean" ? value : fallback;
};

export function snapShotSettings(): SnapShotSettings {
  const sound = readSetting("snapShotSound", "client");
  return {
    snapShotEnabled: bool("snapShotEnabled", false),
    snapShotIncludeAccessibility: bool("snapShotIncludeAccessibility", true),
    snapShotShortcut: decodeSnapShotShortcut(readSetting("snapShotShortcut", "client")),
    snapShotPlaySound: bool("snapShotPlaySound", true),
    snapShotSound: sound === "camera-shutter" ? "camera-shutter" : "soft-pop",
    snapShotFlash: bool("snapShotFlash", true),
    snapShotAnimations: bool("snapShotAnimations", true),
  };
}

export type SnapShotSettingsPatch = Partial<SnapShotSettings>;

/** updateClientSettings for the SnapShot keys (the shortcut object is kept as its JSON, the client blob holds scalars). */
export async function saveSnapShotSettings(patch: SnapShotSettingsPatch): Promise<void> {
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    await writeSetting(field, "client", typeof value === "object" ? JSON.stringify(value) : (value as string | boolean));
  }
}

// --- state ------------------------------------------------------------------------------------------------------------

/** The last state read (desktopSnapShotAtom); `null` until the first read. */
export const snapShotState = signal<DesktopSnapShotState | null>(null);

/** The last capture's answer for Screen Recording (there is no query macOS offers an app without native code): granted
 * after a capture wrote an image, denied after one was refused, unknown before any capture ran. Exported for the
 * permissions helper (permissionsHelper.ts), which composes this with `accessibilityTrusted` instead of duplicating
 * the storage key. */
export async function screenRecordingGranted(): Promise<boolean> {
  try { return (await desktop().getItem(SCREEN_RECORDING_KEY)) === "granted"; } catch { return false; }
}

async function rememberScreenRecording(granted: boolean) {
  try { await desktop().setItem(SCREEN_RECORDING_KEY, granted ? "granted" : "denied"); } catch { /* storage full */ }
}

/** Whether a key chord can be bound in-app: keymap refuses the keystrokes the platform keeps (Command+Q ...). */
function keystrokeBindable(keystroke: string): boolean {
  try { keymap.bind(keystroke, () => undefined)(); return true; } catch { return false; }
}

/** getSnapShotState. A modifier pair reads `modifierPairShortcutStatus` (the installer's own poller state) instead
 * of spawning anything here: this function runs on every settings change and UI refresh, and must stay a pure read. */
export async function getSnapShotState(): Promise<DesktopSnapShotState> {
  const settings = snapShotSettings();
  const shortcut = settings.snapShotShortcut;
  if (!isMac()) {
    return { mode: "unavailable", shortcut, shortcutRegistered: false, shortcutMessage: null, message: "SnapShots are not supported on this platform." };
  }
  const screenRecording = await screenRecordingGranted();
  const macPermissions = { screenRecording, accessibility: await accessibilityTrusted() };
  const macFlashAvailable = await snapShotFlashAvailable();
  if (!settings.snapShotEnabled) {
    return { mode: "direct", shortcut, shortcutRegistered: false, shortcutMessage: null, macPermissions, macFlashAvailable, message: null };
  }
  const permissionMessage = macPermissionMessage(macPermissions, settings.snapShotIncludeAccessibility);
  if (permissionMessage) {
    return { mode: "direct", shortcut, shortcutRegistered: false, shortcutMessage: null, macPermissions, macFlashAvailable, message: permissionMessage };
  }
  if (isModifierPairShortcut(shortcut)) {
    const status = modifierPairShortcutStatus();
    const current = status.modifier === snapShotShortcutModifierPair(shortcut);
    return {
      mode: "direct", shortcut, macPermissions, macFlashAvailable, message: null,
      shortcutRegistered: current && status.registered,
      shortcutMessage: current ? status.message : null,
    };
  }
  const keystroke = snapShotKeystroke(shortcut);
  const registered = keystroke !== null && keystrokeBindable(keystroke);
  return {
    mode: "direct", shortcut, shortcutRegistered: registered, macPermissions, macFlashAvailable, message: null,
    shortcutMessage: registered ? null : "This shortcut is already used by the system or another app.",
  };
}

/** refreshDesktopSnapShotState: reads the state and publishes it. */
export async function refreshSnapShotState(): Promise<DesktopSnapShotState> {
  const state = await getSnapShotState();
  snapShotState.set(state);
  return state;
}

/** checkSnapShotShortcut. A modifier pair is probed for real (start the poller, then stop it), as
 * DesktopSnapShot.ts's own `checkShortcut` does, instead of always reporting it unavailable. */
export async function checkSnapShotShortcut(shortcut: SnapShotShortcut): Promise<DesktopSnapShotShortcutAvailability> {
  if (isModifierPairShortcut(shortcut)) {
    if (!isMac()) return { available: false, message: modifierPairUnavailableMessage(shortcut) };
    return probeModifierPairShortcut(snapShotShortcutModifierPair(shortcut));
  }
  const keystroke = snapShotKeystroke(shortcut);
  if (keystroke === null || !keystrokeBindable(keystroke)) return { available: false, message: "This shortcut is already used by the system or another app." };
  return { available: true, message: null };
}

// --- capture ------------------------------------------------------------------------------------------------------------

export type CaptureResult =
  | { status: "captured"; path: string; sizeBytes: number; capturedAt: string }
  | { status: "cancelled" }
  | { status: "denied"; message: string }
  | { status: "failed"; message: string };

/** screencapture's answer when Screen Recording is not allowed. */
export function isScreenCaptureDenied(output: { stdout: string; stderr: string }): boolean {
  return /could not create image/i.test(`${output.stdout}\n${output.stderr}`);
}

/** The arguments of an interactive window capture: window selection only (-i -w), no shadow (-o), no system sound (-x). */
export function interactiveCaptureArgs(path: string): string[] {
  return ["-i", "-w", "-o", "-x", "-t", "png", path];
}

/** macSnapShotArguments: the window `windowId` (CGWindowNumber), no shadow, no sound. */
export function windowCaptureArgs(windowId: number, path: string): string[] {
  return ["-l", String(windowId), "-o", "-x", "-t", "png", path];
}

/** The arguments of the setup's test capture: one point of the screen, discarded after. */
export function testCaptureArgs(path: string): string[] {
  return ["-x", "-R0,0,1,1", "-t", "png", path];
}

async function runCapture(args: (path: string) => string[], id: string, timeoutMs: number | null): Promise<CaptureResult> {
  const dir = snapshotsDir();
  if (!dir) return { status: "failed", message: "This app has no data folder to save the snapshot in." };
  await desktop().mkdir(dir);
  const path = `${dir}/${id}.png`;
  const capturedAt = desktop().now().toISOString();
  let output;
  try {
    output = await desktop().run(SCREENCAPTURE, args(path), { timeoutMs });
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : "Could not run screencapture." };
  }
  if (isScreenCaptureDenied(output)) {
    await rememberScreenRecording(false);
    return { status: "denied", message: MAC_SCREEN_CAPTURE_PERMISSION_MESSAGE };
  }
  const size = await desktop().fileSize(path);
  if (size === null || size === 0) {
    // Escape or a click outside a window ends the pick without an image.
    if (output.code === 0 || output.code === 1) return { status: "cancelled" };
    return { status: "failed", message: `Capturing the window failed: screencapture exited with code ${output.code}.` };
  }
  await rememberScreenRecording(true);
  return { status: "captured", path, sizeBytes: size, capturedAt };
}

/** The window the last capture took (null: the user picked it), for the source probe. */
export let lastCapturedWindow: ActiveWindow | null = null;

/** Captures the frontmost app's window to `<dataDir>/snapshots/window-<time>.png` (15 s, MAC_SCREEN_CAPTURE_TIMEOUT_MS). When the
 * frontmost app is this one, or no window could be found, the user picks the window (no deadline: picking takes their time). */
export async function captureWindow(): Promise<CaptureResult> {
  const capturedAt = desktop().now().toISOString();
  const id = `window-${capturedAt.replaceAll(":", "-")}`;
  const active = await activeMacWindow();
  if (active && active !== "self") {
    lastCapturedWindow = active;
    return runCapture((path) => windowCaptureArgs(active.id, path), id, 15_000);
  }
  lastCapturedWindow = null;
  return runCapture(interactiveCaptureArgs, id, null);
}

/** setupSnapShot("test-mac-capture"): a test capture that settles Screen Recording; the image is discarded. */
export async function testMacCapture(): Promise<CaptureResult> {
  const result = await runCapture(testCaptureArgs, `test-${desktop().randomId()}`, 15000);
  if (result.status === "captured") await desktop().unlink(result.path).catch(() => undefined);
  return result;
}

export function openMacPermissionSettings(pane: keyof typeof MAC_PERMISSION_SETTINGS_URLS): Promise<boolean> {
  return desktop().openUrl(MAC_PERMISSION_SETTINGS_URLS[pane]).catch(() => false);
}

/** setupSnapShot. */
export async function setupSnapShot(action: DesktopSnapShotSetupAction): Promise<void> {
  if (!isMac()) throw new Error("Test capture requires macOS.");
  if (action === "test-mac-capture" || action === "allow-screen-recording") {
    // The first capture is what makes macOS ask; once it was refused only System Settings can allow it.
    const result = await testMacCapture();
    if (result.status === "denied" || (action === "allow-screen-recording" && result.status !== "captured")) {
      await openMacPermissionSettings("screen-recording");
    }
    if (action === "test-mac-capture" && result.status === "failed") throw new Error(`Could not capture a test snapshot. ${result.message}`);
    return;
  }
  if (action === "allow-accessibility") {
    await openMacPermissionSettings("accessibility");
    return;
  }
  // retry-shortcut: the in-app binding re-reads the settings; nothing else to retry here.
}

/** requestSnapShotPermissions. */
export async function requestSnapShotPermissions(includeAccessibility: boolean): Promise<void> {
  if (!isMac()) return;
  if (!(await screenRecordingGranted())) {
    await setupSnapShot("allow-screen-recording");
  } else if (includeAccessibility && !(await accessibilityTrusted())) {
    await openMacPermissionSettings("accessibility");
  }
}

// --- sound --------------------------------------------------------------------------------------------------------------

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const writtenSounds = new Set<string>();

/** playSnapShotSound: the reference's mp3, played by afplay (no audio API in NSH). */
export async function playSnapShotSound(sound: SnapShotSound): Promise<void> {
  if (!isMac()) return;
  const dir = snapshotsDir();
  if (!dir) return;
  const file = `${dir}/${sound === "soft-pop" ? "snap-shot-whoosh" : "snap-shot-click"}.mp3`;
  try {
    if (!writtenSounds.has(file)) {
      await desktop().mkdir(dir);
      await desktop().writeFile(file, decodeBase64(sound === "soft-pop" ? SNAP_SHOT_WHOOSH_MP3 : SNAP_SHOT_CLICK_MP3));
      writtenSounds.add(file);
    }
    await desktop().run(AFPLAY, [file], { timeoutMs: 10000 });
  } catch { /* the sound is a nicety */ }
}

export { isModifierPairShortcut };
