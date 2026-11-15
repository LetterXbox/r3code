// useSnapShotShortcutRecorder.tsx + desktop/SnapShotShortcutKeys.tsx: the shortcut button that records a new chord.
// The reference listens to raw key events (and so can record Shift + Shift); NSH reports keystrokes through `keymap`
// only, so recording binds every recordable chord while it listens and a modifier pair cannot be recorded here.
import { signal, Text, View } from "nsh";
import { keymap } from "nsh";
import { recordableKeystrokes } from "../keybindingsLogic";
import { snapShotShortcutSuppressed } from "../../../commands/snapShotShortcut";
import { chordFromKeystroke, formatSnapShotShortcutLabel, snapShotShortcutKeyLabels } from "../../../desktop/snapShotShortcut";
import { isModifierPairShortcut, type SnapShotShortcut } from "../../../desktop/snapShotTypes";

export interface ShortcutRecorder {
  recording: () => boolean;
  stopRecording: () => void;
  Input: (props: { shortcut: SnapShotShortcut; disabled: boolean; allowModifierPairs: boolean }) => any;
}

export function createShortcutRecorder(options: { onRecord: (shortcut: SnapShotShortcut) => void; onStart?: () => void }): ShortcutRecorder {
  const recording = signal(false);
  let removers: (() => void)[] = [];
  const stopRecording = () => {
    removers.forEach((remove) => remove());
    removers = [];
    recording.set(false);
    snapShotShortcutSuppressed.set(false);
  };
  const startRecording = () => {
    if (recording()) return;
    options.onStart?.();
    snapShotShortcutSuppressed.set(true);
    const bind = (keystroke: string, handler: () => void) => {
      try { removers.push(keymap.bind(keystroke, handler, { when: "always" })); } catch { /* a keystroke the platform keeps */ }
    };
    for (const keystroke of recordableKeystrokes()) {
      const chord = chordFromKeystroke(keystroke);
      if (!chord) continue;
      bind(keystroke, () => {
        stopRecording();
        options.onRecord(chord);
      });
    }
    bind("escape", stopRecording);
    recording.set(true);
  };

  function Input(props: { shortcut: SnapShotShortcut; disabled: boolean; allowModifierPairs: boolean }) {
    const label = () => `Record snapshot shortcut, currently ${formatSnapShotShortcutLabel(props.shortcut)}`;
    return (
      <View
        role="button"
        accessibilityLabel={label()}
        accessibilityState={{ selected: recording() }}
        testID={recording() ? "Snapshot shortcut (recording)" : `Snapshot shortcut ${formatSnapShotShortcutLabel(props.shortcut)}`}
        disabled={props.disabled}
        onPress={() => { if (!props.disabled) (recording() ? stopRecording() : startRecording()); }}
        // Button size="xs": outline, secondary while recording.
        class={`h-7 flex-row items-center gap-1 rounded-md px-2 ${recording() ? "bg-secondary" : "border border-input bg-background hover:bg-accent-50"} ${props.disabled ? "opacity-64" : ""}`}
      >
        {recording() ? <Text class="text-xs font-medium text-foreground">Press shortcut…</Text>
          : !props.allowModifierPairs && isModifierPairShortcut(props.shortcut) ? <Text class="text-xs font-medium text-foreground">Choose shortcut</Text>
            : <Each of={snapShotShortcutKeyLabels(props.shortcut).map((key, index) => ({ key, index }))} key={(entry) => `${entry.key}-${entry.index}`}>{(entry) => (
              // ui/kbd.tsx Kbd
              <View class="h-5 min-w-5 items-center justify-center rounded bg-muted px-1"><Text class="text-xs font-medium text-muted-foreground">{entry().key}</Text></View>
            )}</Each>}
      </View>
    );
  }

  return { recording: () => recording(), stopRecording, Input };
}
