// Every state of the composer's primary action (ComposerPrimaryActions.tsx) side by side, for comparing with the
// reference in a real window: shown above the composer while `primary-states` exists beside the launcher's bootstrap
// file (forcedRecording.ts). Each tile is the real control with fixed inputs.
import { Text, View } from "nsh";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import type { PrimaryKind } from "./ComposerPrimaryActions";

interface StateCase { name: string; kind: PrimaryKind; disabled?: boolean; busy?: boolean; compact?: string | null; label: string }

export const PRIMARY_ACTION_STATES: StateCase[] = [
  { name: "Idle, empty", kind: "submit", disabled: true, label: "Submit message" },
  { name: "Idle, text", kind: "submit", label: "Submit message" },
  { name: "Sending", kind: "submit", busy: true, disabled: true, label: "Submitting message" },
  { name: "Running, empty", kind: "stop", label: "Stop generation" },
  { name: "Running, queue", kind: "queue", label: "Queue message" },
  { name: "Running, steer", kind: "steer", label: "Steer message" },
  { name: "Editing queued", kind: "update", label: "Update queued message" },
  { name: "Resume", kind: "resume", label: "Resume thread" },
  { name: "Compact first", kind: "submit", compact: "212k", label: "Compact and send" },
  { name: "Blocked", kind: "submit", disabled: true, label: "Acme limits threads to Supervised." },
];

export function PrimaryActionStates() {
  return (
    <View class="flex-row flex-wrap gap-3 rounded-lg border border-border bg-card p-3" testID="primary-action-states">
      <Each of={PRIMARY_ACTION_STATES} key={(item) => item.name}>
        {(item) => (
          <View class="items-center gap-1.5 px-1">
            <ComposerPrimaryActions
              kind={() => item().kind} label={() => item().label} tooltip={() => item().label}
              disabled={() => item().disabled === true} busy={() => item().busy === true}
              onInterrupt={() => {}} onResume={() => {}} onSubmit={() => {}}
              compactTokens={() => item().compact ?? null}
            />
            <Text class="text-2xs text-muted-foreground">{item().name}</Text>
          </View>
        )}
      </Each>
    </View>
  );
}
