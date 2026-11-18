// The SnapShot capture shortcut (the reference registers it globally from the desktop main process). NSH binds
// app-level keystrokes only, so the shortcut captures while T3 Code has the keyboard; a modifier pair (Shift + Shift)
// cannot be bound at all and stays unregistered (desktop/snapShot.ts reports why). The shortcut is not one of
// packages/shared keybindings.ts's command ids, so it is bound here rather than through the rule table.
import { effect, keymap, signal } from "nsh";
import { captureSnapShotToDraft } from "../desktop/snapShotCapture";
import { snapShotSettings } from "../desktop/snapShot";
import { snapShotKeystroke } from "../desktop/snapShotShortcut";

/** setSnapShotShortcutSuppressed: true while the shortcut recorder listens. */
export const snapShotShortcutSuppressed = signal(false);

/** The keystroke currently bound for capture (for tests and diagnostics). */
export const boundSnapShotKeystroke = signal<string | null>(null);

let unbind: (() => void) | null = null;

export function installSnapShotShortcut(capture: () => unknown = captureSnapShotToDraft) {
  effect(() => {
    const settings = snapShotSettings();
    const keystroke = settings.snapShotEnabled && !snapShotShortcutSuppressed() ? snapShotKeystroke(settings.snapShotShortcut) : null;
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
