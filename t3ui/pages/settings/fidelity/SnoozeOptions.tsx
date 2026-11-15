// SnoozePresetsRow (SnoozePresetsSettings.tsx): the editor under "Snooze options". Each option is a "When" select
// (In, Today, Tomorrow, a weekday), then an amount and unit for a duration or a time of day, the menu entry it would
// make, and a remove button; "Menu now" lists the resulting snooze menu and "Add option" appends the next unused default.
// Edits build on a local draft and write the whole list to the server (`snoozePresets`, optimistic, reverted on failure).
import { computed, effect, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";
import { SettingsSelect } from "../../../components/SettingsLayout";
import { SettingsIcon } from "../SettingsIcon";
import { readSetting, writeSetting } from "../settingsSync";
import { PillButton, UiIcon } from "../providers/ui";
import { createStepperKeys } from "../../../components/stepperKeys";
import {
  DEFAULT_SNOOZE_PRESETS, MAX_SNOOZE_PRESETS, MAX_SNOOZE_PRESET_MINUTES, SINGULAR_UNIT_LABELS, UNIT_LABELS, UNIT_MINUTES, WHEN_LABELS, WHEN_VALUES,
  menuNowLine, nextCandidate, readSnoozePresets, sameSnoozePresets, snoozePreviews, sortSnoozeRows, splitMinutes, withWhen,
  type DurationUnit, type KindMemory, type SnoozePresetSetting,
} from "./snoozeLogic";

const FIELD = "snoozePresets";
const saved = () => readSnoozePresets(readSetting(FIELD, "server"));

/** Whether the list differs from the defaults (the row's reset mark) and the write that restores them. */
export const snoozeOptionsChanged = () => !sameSnoozePresets(saved(), DEFAULT_SNOOZE_PRESETS);
export const resetSnoozeOptions = () => void writeSetting(FIELD, "server", [...DEFAULT_SNOOZE_PRESETS] as never);

function DurationFields(props: { minutes: number; onChange: (minutes: number) => void }) {
  const chosenUnit = signal<DurationUnit>(untracked(() => splitMinutes(props.minutes).unit));
  const unit = computed<DurationUnit>(() => (props.minutes % UNIT_MINUTES[chosenUnit()] === 0 ? chosenUnit() : splitMinutes(props.minutes).unit));
  const amount = () => props.minutes / UNIT_MINUTES[unit()];
  const maxAmount = () => Math.floor(MAX_SNOOZE_PRESET_MINUTES / UNIT_MINUTES[unit()]);
  const draft = signal<string | null>(null);
  const commit = () => {
    const text = draft();
    draft.set(null);
    if (text === null) return;
    const value = Number(text);
    if (!Number.isFinite(value)) return;
    const next = Math.min(maxAmount(), Math.max(1, Math.round(value)));
    if (next !== amount()) props.onChange(next * UNIT_MINUTES[unit()]);
  };
  const step = (delta: number) => {
    const next = Math.min(maxAmount(), Math.max(1, amount() + delta));
    if (next !== amount()) props.onChange(next * UNIT_MINUTES[unit()]);
  };
  const labels = () => (amount() === 1 ? SINGULAR_UNIT_LABELS : UNIT_LABELS);
  // NumberField min 1, max maxAmount, step 1: the arrows step from the typed draft when there is one.
  const keys = createStepperKeys(() => { const text = draft(); const typed = text === null ? NaN : Number(text); return Number.isFinite(typed) ? Math.round(typed) : amount(); }, (next) => { draft.set(null); if (next !== amount()) props.onChange(next * UNIT_MINUTES[unit()]); }, () => ({ min: 1, max: maxAmount() }));
  return (
    <View class="min-w-0 flex-row flex-wrap items-center gap-2">
      <View class="h-7 w-32 flex-row items-center overflow-hidden rounded-lg border border-input bg-background">
        <View accessibilityLabel="Decrease" role="button" onPress={() => step(-1)} class="size-7 items-center justify-center hover:bg-accent transition-colors duration-150 ease-in-out"><SettingsIcon name="minus" size={14} /></View>
        <Input
          value={draft() ?? String(amount())} accessibilityLabel="Amount" keyboardType="number-pad"
          onChange={(e: { value: string }) => draft.set(e.value)} onFocus={keys.onFocus} onBlur={() => { keys.onBlur(); commit(); }} onSubmit={commit}
          class="h-7 min-w-0 flex-1 px-1 text-center text-sm text-foreground"
        />
        <View accessibilityLabel="Increase" role="button" onPress={() => step(1)} class="size-7 items-center justify-center hover:bg-accent transition-colors duration-150 ease-in-out"><SettingsIcon name="plus" size={14} /></View>
      </View>
      <SettingsSelect
        label="Unit" value={unit()} compactWidth={112}
        options={(Object.keys(UNIT_LABELS) as DurationUnit[]).map((value) => ({ value, label: labels()[value] }))}
        onChange={(value) => {
          if (value === "minutes" || value === "hours" || value === "days") {
            chosenUnit.set(value);
            props.onChange(Math.min(amount() * UNIT_MINUTES[value], MAX_SNOOZE_PRESET_MINUTES));
          }
        }}
      />
    </View>
  );
}

function PresetFields(props: { preset: SnoozePresetSetting; onChange: (preset: SnoozePresetSetting) => void }) {
  const memory = signal<KindMemory>({ minutes: 60, time: "09:00" });
  const when = () => (props.preset.kind === "after" ? "after" : props.preset.day);
  const time = signal<string | null>(null);
  return (
    <View class="min-w-0 flex-row flex-wrap items-center gap-2">
      <SettingsSelect
        label="When" value={when()} compactWidth={128} options={WHEN_VALUES.map((value) => ({ value, label: WHEN_LABELS[value] ?? value }))}
        onChange={(value) => {
          const next = withWhen(props.preset, value, memory());
          if (!next) return;
          if (next.kind !== props.preset.kind) memory.set(props.preset.kind === "after" ? { ...memory(), minutes: props.preset.minutes } : { ...memory(), time: props.preset.time });
          props.onChange(next);
        }}
      />
      {props.preset.kind === "after" ? (
        <DurationFields minutes={props.preset.minutes} onChange={(minutes) => props.onChange({ kind: "after", minutes })} />
      ) : (
        <View class="min-w-0 flex-row flex-wrap items-center gap-2">
          <Text class="text-xs text-muted-foreground">at</Text>
          <Input
            value={time() ?? (props.preset.kind === "at" ? props.preset.time : "")} accessibilityLabel="Time" placeholder="HH:MM" maxLength={5}
            onChange={(e: { value: string }) => {
              time.set(e.value);
              if (/^([01]\d|2[0-3]):[0-5]\d$/.test(e.value) && props.preset.kind === "at") props.onChange({ ...props.preset, time: e.value });
            }}
            onBlur={() => time.set(null)}
            class="h-7 w-32 rounded-lg border border-input bg-background px-[9px] text-sm text-foreground"
          />
        </View>
      )}
    </View>
  );
}

export function SnoozeOptions() {
  const now = () => new Date();
  // The draft: edits build on it, so a second edit before the first save echoes back does not restore what the first changed.
  const rows = signal<SnoozePresetSetting[]>(sortSnoozeRows(untracked(saved), now()));
  let written = JSON.stringify(untracked(rows));
  // A value that is neither the draft nor our last write came from elsewhere (another client, a failed write reverting): adopt it.
  effect(() => {
    const incoming = JSON.stringify(saved());
    untracked(() => {
      if (incoming === written || incoming === JSON.stringify(rows())) return;
      written = incoming;
      rows.set(sortSnoozeRows(saved(), now()));
    });
  });
  const save = (next: SnoozePresetSetting[]) => {
    rows.set(next);
    written = JSON.stringify(next);
    void writeSetting(FIELD, "server", next as never);
  };
  const previews = computed(() => snoozePreviews(rows(), now()));
  return (
    <View class="px-4 pt-1 pb-3.5" testID="Snooze options list">
      <View class="gap-1.5 pt-2">
        <Each of={rows().map((preset, index) => ({ preset, index }))} key={(entry) => `${entry.index}:${JSON.stringify(entry.preset)}`}>
          {(entry) => {
            const preview = () => previews()[entry().index];
            return (
              <View class="flex-row flex-wrap items-center gap-2" accessibilityLabel={`Snooze option ${entry().index + 1}`}>
                <PresetFields preset={entry().preset} onChange={(next) => save(rows().map((preset, index) => (index === entry().index ? next : preset)))} />
                <View class="ml-auto min-w-0 flex-row items-center gap-2">
                  {preview()?.tone === "menu" ? (
                    <View class="flex-row gap-2">
                      <Text class="text-xs text-foreground">{(preview() as { label: string }).label}</Text>
                      <Text class="text-xs text-muted-foreground">{(preview() as { when: string }).when}</Text>
                    </View>
                  ) : <Text class="text-xs text-muted-foreground">{(preview() as { text: string } | undefined)?.text ?? ""}</Text>}
                  <View accessibilityLabel={`Remove snooze option ${entry().index + 1}`} role="button" onPress={() => save(rows().filter((_, index) => index !== entry().index))} class="size-7 items-center justify-center rounded-lg hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out">
                    <UiIcon name="x" size={14} />
                  </View>
                </View>
              </View>
            );
          }}
        </Each>
        <Text class="text-xs text-muted-foreground">{menuNowLine(rows(), now())}</Text>
        <View class="flex-row items-center gap-2">
          <PillButton label="Add option" size="xs" variant="ghost" disabled={rows().length >= MAX_SNOOZE_PRESETS} onPress={() => save([...rows(), nextCandidate(rows())])}>
            <UiIcon name="plus" size={14} /><Text class="text-sm text-muted-foreground">Add option</Text>
          </PillButton>
          {rows().length >= MAX_SNOOZE_PRESETS ? <Text class="text-xs text-muted-foreground">{`Up to ${MAX_SNOOZE_PRESETS} options`}</Text> : null}
        </View>
      </View>
    </View>
  );
}
