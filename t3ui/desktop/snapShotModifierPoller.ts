// The macOS modifier-pair SnapShot shortcut (Shift + Shift, etc.), ported from the reference's
// snapShot/MacModifierPairShortcutProcess.ts. NSH binds app-level keystrokes only (desktop/snapShotShortcut.ts
// snapShotKeystroke returns null for a modifier pair: keymap cannot bind a modifier alone), so this polls the
// system's own modifier-key state through an `osascript -l JavaScript` child (already allowlisted in nsh.json
// capabilities.process.execute), exactly as the reference's Electron main process does with `node:child_process`.
// JXA's `console.log` writes to the child's stderr (not stdout), so the handshake below listens there, as the
// reference does (`poller.stderr.on("data", ...)`).
import { signal } from "nsh";
import { desktop } from "./runtime";
import { snapShotModifierPairLabel, type SnapShotModifier } from "./snapShotTypes";

/** MAC_MODIFIER_PAIR_DEVICE_MASKS: the left/right NSEventModifierFlags-style device masks `CGEventSourceFlagsState`
 * reports for each key of a pair. */
const MAC_MODIFIER_PAIR_DEVICE_MASKS: Record<SnapShotModifier, readonly [number, number]> = {
  shift: [0x2, 0x4],
  control: [0x1, 0x2000],
  alt: [0x20, 0x40],
  meta: [0x8, 0x10],
};

/** CoreGraphics registers osascript as a foreground app; go background-only first to avoid a Dock tile. */
export const MAC_MODIFIER_PAIR_POLLER_SCRIPT = `
ObjC.import("AppKit");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
ObjC.import("CoreGraphics");
ObjC.import("unistd");
function run(argv) {
  const left = Number(argv[0]);
  const right = Number(argv[1]);
  const both = left | right;
  let active = false;
  console.log("ready");
  while ($.getppid() !== 1) {
    const pressed = ($.CGEventSourceFlagsState(0) & both) === both;
    if (pressed && !active) console.log("trigger");
    active = pressed;
    delay(0.05);
  }
  return "orphaned";
}`;

export const MAC_MODIFIER_PAIR_READY_TIMEOUT_MS = 5_000;

/** Starts the poller for `modifier`'s pair and resolves a stop function once it reports "ready" (so `checkShortcut`
 * can start-then-stop it as a probe, and the installer can keep it running). Rejects when it fails before "ready"
 * (the osascript binary is missing, say), and calls `onFailure` for a later failure (it exited, or errored) once
 * started. `onTrigger` fires once per press-and-release of both keys of the pair (never while held). */
export function startMacModifierPairShortcutProcess(
  modifier: SnapShotModifier,
  onTrigger: () => void,
  onFailure: (error: Error) => void,
): Promise<() => void> {
  const [left, right] = MAC_MODIFIER_PAIR_DEVICE_MASKS[modifier];
  const child = desktop().spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_MODIFIER_PAIR_POLLER_SCRIPT, String(left), String(right)]);

  return new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill();
    };
    const fail = (error: Error) => {
      if (stopped) return;
      if (settled) {
        stop();
        onFailure(error);
        return;
      }
      settled = true;
      stop();
      reject(error);
    };
    const readyTimer = setTimeout(() => fail(new Error("Snapshot shortcut helper did not start in time.")), MAC_MODIFIER_PAIR_READY_TIMEOUT_MS);

    child.onLine("stderr", (line) => {
      const message = line.trim();
      if (message === "ready" && !settled) {
        clearTimeout(readyTimer);
        settled = true;
        resolve(stop);
        return;
      }
      if (message !== "trigger" || !settled || stopped) return;
      try { onTrigger(); } catch { /* a listener's own error never kills the poller */ }
    });
    child.onExit((result) => {
      clearTimeout(readyTimer);
      fail(new Error(`Snapshot shortcut helper exited with code ${result.code}`));
    });
  });
}

// --- the shortcut's live state (DesktopSnapShot.ts's registeredAccelerator / shortcutVerified, for a modifier pair) ---

function observedPairMessage(modifier: SnapShotModifier): string {
  return `${snapShotModifierPairLabel(modifier, true)} is observed and cannot be reserved exclusively.`;
}

export function unavailablePairMessage(modifier: SnapShotModifier): string {
  return `${snapShotModifierPairLabel(modifier, true)} is not available on this system.`;
}

export interface ModifierPairShortcutStatus { modifier: SnapShotModifier | null; registered: boolean; message: string | null }

/** The modifier pair currently polled (if any) and whether it is actually running. desktop/snapShot.ts's
 * `getSnapShotState` reads this instead of starting anything itself — only `ensureModifierPairShortcut` (the
 * installer) and `probeModifierPairShortcut` (a one-shot check) ever spawn a poller. */
export const modifierPairShortcutStatus = signal<ModifierPairShortcutStatus>({ modifier: null, registered: false, message: null });

let generation = 0;
let active: { modifier: SnapShotModifier; stop: () => void } | null = null;

/** Starts (or restarts, or stops) the poller so it matches `modifier` (DesktopSnapShot.ts's shortcutGeneration:
 * settings can change again before a pending start resolves, and a stale poller must be killed rather than kept).
 * `null` stops any running poller. `onTrigger` is the capture to run on each press of the pair. */
export function ensureModifierPairShortcut(modifier: SnapShotModifier | null, onTrigger: () => void): void {
  if (active?.modifier === modifier && (modifier === null || modifierPairShortcutStatus().registered)) return;
  generation += 1;
  const myGeneration = generation;
  active?.stop();
  active = null;
  if (modifier === null) {
    modifierPairShortcutStatus.set({ modifier: null, registered: false, message: null });
    return;
  }
  modifierPairShortcutStatus.set({ modifier, registered: false, message: null });
  startMacModifierPairShortcutProcess(
    modifier,
    onTrigger,
    () => {
      if (generation !== myGeneration) return;
      active = null;
      modifierPairShortcutStatus.set({ modifier, registered: false, message: unavailablePairMessage(modifier) });
    },
  ).then(
    (stop) => {
      if (generation !== myGeneration) { stop(); return; }
      active = { modifier, stop };
      modifierPairShortcutStatus.set({ modifier, registered: true, message: observedPairMessage(modifier) });
    },
    () => {
      if (generation !== myGeneration) return;
      modifierPairShortcutStatus.set({ modifier, registered: false, message: unavailablePairMessage(modifier) });
    },
  );
}

/** Starts the poller just long enough to know it can run, then stops it (DesktopSnapShot.ts checkShortcut's own
 * probe for a candidate shortcut, before it is saved). */
export async function probeModifierPairShortcut(modifier: SnapShotModifier): Promise<{ available: boolean; message: string | null }> {
  try {
    const stop = await startMacModifierPairShortcutProcess(modifier, () => undefined, () => undefined);
    stop();
    return { available: true, message: observedPairMessage(modifier) };
  } catch {
    return { available: false, message: unavailablePairMessage(modifier) };
  }
}
