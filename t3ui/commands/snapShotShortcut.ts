// The SnapShot capture shortcut (the reference registers it globally from the desktop main process). NSH binds
// app-level keystrokes only, so a key chord captures while T3 Code has the keyboard (keymap.bind below). A modifier
// pair (the default Shift + Shift) cannot be bound that way at all — isModifierPairShortcut's snapShotKeystroke
// returns null for it — so it instead runs desktop/snapShotModifierPoller.ts's osascript poller, which does see the
// pair pressed system-wide (desktop/snapShot.ts's getSnapShotState reports the poller's own live state). The
// shortcut is not one of packages/shared keybindings.ts's command ids, so it is bound here rather than through the
// rule table.
import { effect, keymap, signal } from "nsh";
import { captureSnapShotToDraft, drainPendingSnapShots } from "../desktop/snapShotCapture";
import { isMac } from "../desktop/runtime";
import { snapShotSettings } from "../desktop/snapShot";
import { ensureModifierPairShortcut } from "../desktop/snapShotModifierPoller";
import { snapShotKeystroke } from "../desktop/snapShotShortcut";
import { isModifierPairShortcut, snapShotShortcutModifierPair } from "../desktop/snapShotTypes";

/** setSnapShotShortcutSuppressed: true while the shortcut recorder listens. */
export const snapShotShortcutSuppressed = signal(false);

/** The keystroke currently bound for capture (for tests and diagnostics). */
export const boundSnapShotKeystroke = signal<string | null>(null);

let unbind: (() => void) | null = null;

export function installSnapShotShortcut(capture: () => unknown = captureSnapShotToDraft) {
  void drainPendingSnapShots().catch(() => undefined);
  effect(() => {
    const settings = snapShotSettings();
    const active = settings.snapShotEnabled && !snapShotShortcutSuppressed();
    const shortcut = active ? settings.snapShotShortcut : null;
    if (isMac()) {
      ensureModifierPairShortcut(shortcut && isModifierPairShortcut(shortcut) ? snapShotShortcutModifierPair(shortcut) : null, () => { void capture(); });
    }
    // snapShotKeystroke itself returns null for a modifier pair (keymap cannot bind modifiers alone).
    const keystroke = shortcut ? snapShotKeystroke(shortcut) : null;
    queueMicrotask(() => {
      if (boundSnapShotKeystroke() === keystroke) return;
      unbind?.();
      unbind = null;
      boundSnapShotKeystroke.set(null);
      if (!keystroke) return;
      try {
        unbind = keymap.bind(keystroke, () => { void capture(); }, { when: "always" });
        boundSnapShotKeystroke.set(keystroke);
      } catch { /* a keystroke the platform keeps */ }
    });
  });
}
