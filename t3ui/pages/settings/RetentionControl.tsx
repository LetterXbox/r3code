// The Worktrees and Maintenance "delete after N days" rows' control, ported from
// StorageSettings.tsx's RetentionControl: a days stepper while the rule is on, "Off"
// while it is not, and a switch that turns it on at 8 days.
import { effect, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { SettingsIcon } from "./SettingsIcon";
import { createStepperKeys } from "../../components/stepperKeys";
import { SettingsSwitch } from "../../components/SettingsLayout";
import { MAX_RETENTION_DAYS, RETENTION_OFF, RETENTION_ON_DEFAULT } from "./controlSpecs";

/** The day count a typed draft commits as, or null when it is not a number. */
export function committedDays(draft: string, minimum: number): number | null {
  if (draft.trim() === "") return null;
  const parsed = Number(draft);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(MAX_RETENTION_DAYS, Math.max(minimum, Math.round(parsed)));
}

export function RetentionControl(props: {
  label: string;
  /** A day count, or RETENTION_OFF. */
  value: string | number;
  minimum: number;
  onChange: (next: string | number) => void;
}) {
  const days = () => (typeof props.value === "number" ? props.value : null);
  const draft = signal(String(days() ?? ""));
  let committed = days();
  effect(() => {
    const next = days();
    if (next !== committed) { committed = next; draft.set(next === null ? "" : String(next)); }
  });
  let timer: number | null = null;
  const commit = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const next = committedDays(draft(), props.minimum);
    if (next === null) { draft.set(String(committed ?? "")); return; }
    draft.set(String(next));
    if (next !== committed) { committed = next; props.onChange(next); }
  };
  const step = (by: number) => {
    const current = days() ?? props.minimum;
    const next = Math.min(MAX_RETENTION_DAYS, Math.max(props.minimum, current + by));
    if (next !== current) props.onChange(next);
  };
  // NumberField min `minimum`, max 3650, step 1: the arrows step from the typed draft when it is a number.
  const keys = createStepperKeys(() => committedDays(draft(), props.minimum) ?? days() ?? props.minimum, (next) => {
    if (timer) clearTimeout(timer);
    timer = null;
    draft.set(String(next));
    if (next !== committed) { committed = next; props.onChange(next); }
  }, () => ({ min: props.minimum, max: MAX_RETENTION_DAYS }));
  return (
    <View class="flex-row items-center gap-3">
      {days() !== null ? (
        <View class="h-6.5 flex-row items-center rounded-lg border border-input bg-background" testID={`${props.label} = ${days()}`}>
          <View class="h-6.5 items-center justify-center px-2.5" accessibilityLabel={`Decrease ${props.label}`} onPress={() => step(-1)}>
            <SettingsIcon name="minus" size={14} />
          </View>
          <Input
            value={draft()}
            onChange={(e: { value: string }) => {
              draft.set(e.value);
              if (timer) clearTimeout(timer);
              timer = setTimeout(commit, 600);
            }}
            onSubmit={commit}
            onFocus={keys.onFocus}
            onBlur={keys.onBlur}
            accessibilityLabel={`${props.label} in days`}
            class="h-6.5 w-12 bg-transparent px-1 text-right text-sm text-foreground"
          />
          <Text class="pr-2 text-xs text-foreground">days</Text>
          <View class="h-6.5 items-center justify-center px-2.5" accessibilityLabel={`Increase ${props.label}`} onPress={() => step(1)}>
            <SettingsIcon name="plus" size={14} />
          </View>
        </View>
      ) : (
        <Text class="text-xs text-muted-foreground">Off</Text>
      )}
      <SettingsSwitch label={props.label} checked={days() !== null} onChange={(on) => props.onChange(on ? Math.max(RETENTION_ON_DEFAULT, props.minimum) : RETENTION_OFF)} />
    </View>
  );
}
