// packages/contracts ipc.ts DesktopSnapShotState and settings.ts SnapShotShortcut, as the bridge returns them.

export type SnapShotModifier = "shift" | "meta" | "control" | "alt";
export interface SnapShotKeyChord { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; modKey: boolean }
export type SnapShotShortcut =
  | { kind: "both-shift-keys" }
  | { kind: "modifier-pair"; modifier: SnapShotModifier }
  | SnapShotKeyChord;
export type SnapShotSound = "soft-pop" | "camera-shutter";

export type DesktopSnapShotSetupAction =
  | "install-extension" | "enable-extension" | "disable-extension" | "install-kde-helper" | "remove-kde-helper"
  | "install-hyprland-helper" | "remove-hyprland-helper" | "test-mac-capture" | "allow-screen-recording"
  | "allow-accessibility" | "retry-shortcut";

export interface DesktopCaptureExtensionState {
  status: "not-installed" | "disabled" | "enabled" | "restart-required" | "update-required" | "extensions-disabled" | "unsupported" | "error";
  message: string;
}
export interface DesktopCaptureHelperState { status: "not-installed" | "update-required" | "ready" | "error"; message: string; feedbackAvailable?: boolean }

export interface DesktopSnapShotState {
  mode: "direct" | "portal" | "unavailable";
  windows?: boolean;
  linuxDesktop?: "gnome" | "kde" | "niri" | "hyprland";
  linuxBackend?: "screenshot-portal" | "gnome-extension" | "niri" | "kde" | "hyprland" | "picker";
  linuxFeedbackAvailable?: boolean;
  shortcut: SnapShotShortcut;
  shortcutRegistered: boolean;
  shortcutPending?: boolean;
  shortcutCanRetry?: boolean;
  shortcutLabel?: string;
  shortcutMessage: string | null;
  shortcutBinding?: string;
  shortcutConfigPath?: string;
  shortcutActionRegistered?: boolean;
  gnomeExtension?: DesktopCaptureExtensionState;
  kdeHelper?: DesktopCaptureHelperState;
  hyprlandHelper?: DesktopCaptureHelperState;
  macPermissions?: { screenRecording: boolean; accessibility: boolean };
  shortcutVerified?: boolean;
  message: string | null;
}

export interface DesktopSnapShotShortcutAvailability { available: boolean; message: string | null }

export const DEFAULT_SNAP_SHOT_SHORTCUT: SnapShotShortcut = { kind: "both-shift-keys" };

export function isModifierPairShortcut(shortcut: SnapShotShortcut): shortcut is Extract<SnapShotShortcut, { kind: string }> {
  return "kind" in shortcut;
}

export function snapShotShortcutModifierPair(shortcut: Extract<SnapShotShortcut, { kind: string }>): SnapShotModifier {
  return shortcut.kind === "both-shift-keys" ? "shift" : shortcut.modifier;
}

const APPLE_MODIFIER_LABELS: Record<SnapShotModifier, string> = { shift: "Shift", meta: "Command", control: "Control", alt: "Option" };
const OTHER_MODIFIER_LABELS: Record<SnapShotModifier, string> = { shift: "Shift", meta: "Super", control: "Ctrl", alt: "Alt" };

export function snapShotModifierPairLabel(modifier: SnapShotModifier, apple: boolean): string {
  const label = (apple ? APPLE_MODIFIER_LABELS : OTHER_MODIFIER_LABELS)[modifier];
  return `${label} + ${label}`;
}

/** Decodes a stored shortcut, the reference default when it is missing or malformed. */
export function decodeSnapShotShortcut(value: unknown): SnapShotShortcut {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return DEFAULT_SNAP_SHOT_SHORTCUT; }
  }
  if (!parsed || typeof parsed !== "object") return DEFAULT_SNAP_SHOT_SHORTCUT;
  const record = parsed as Record<string, unknown>;
  if (record.kind === "both-shift-keys") return { kind: "both-shift-keys" };
  if (record.kind === "modifier-pair" && ["shift", "meta", "control", "alt"].includes(record.modifier as string)) {
    return { kind: "modifier-pair", modifier: record.modifier as SnapShotModifier };
  }
  if (typeof record.key === "string" && record.key.length > 0) {
    const chord: SnapShotKeyChord = {
      key: record.key, metaKey: record.metaKey === true, ctrlKey: record.ctrlKey === true,
      shiftKey: record.shiftKey === true, altKey: record.altKey === true, modKey: record.modKey === true,
    };
    // "Snapshot shortcut requires a modifier."
    if (chord.metaKey || chord.ctrlKey || chord.shiftKey || chord.altKey || chord.modKey) return chord;
  }
  return DEFAULT_SNAP_SHOT_SHORTCUT;
}
