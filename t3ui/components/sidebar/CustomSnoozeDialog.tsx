// CustomSnoozeDialog.tsx: "Custom snooze" / "Choose when snoozed threads return to your
// inbox.", a Date and time / Duration toggle, and Cancel / Snooze. resolveCustomSnooze is
// ported from packages/client-runtime/src/state/threadSettled.ts.
import { signal, Text, View } from "nsh";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { Dialog } from "nsh/base";
import { DialogInput as Input } from "../DialogInput";
import { dialogBackdropStyle, dialogPopupMotion, keepPressInDialog } from "../dialogSurface";
import { DIALOG_MS } from "../motion/motionTokens";
import { SnoozeDateField } from "./SnoozeCalendar";
import { createStepperKeys } from "../stepperKeys";
import { Image, token } from "nsh";
import minusMark from "../../icons/minus.svg";
import plusMark from "../../icons/plus.svg";
import { DialogCloseButton } from "../DialogCloseButton";

export type CustomSnoozeInput =
  | { mode: "date"; date: string; time: string }
  | { mode: "duration"; amount: string; unit: "minutes" | "hours" | "days" };

export function localSnoozeDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function localSnoozeTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The wake time as ISO, or null when the input is malformed or not in the future. */
export function resolveCustomSnooze(input: CustomSnoozeInput, now: Date): string | null {
  let wake: Date;
  if (input.mode === "duration") {
    const amount = Number(input.amount);
    if (input.amount.trim() === "" || !Number.isFinite(amount) || amount <= 0) return null;
    const unitMs = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[input.unit];
    wake = new Date(now.getTime() + amount * unitMs);
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{2}:\d{2}$/.test(input.time)) return null;
    wake = new Date(`${input.date}T${input.time}:00`);
    if (localSnoozeDate(wake) !== input.date || localSnoozeTime(wake) !== input.time) return null;
  }
  return Number.isFinite(wake.getTime()) && wake.getTime() > now.getTime() ? wake.toISOString() : null;
}

/** A YYYY-MM-DD local date, or null. */
export function parseLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return localSnoozeDate(parsed) === value ? parsed : null;
}

type Request = { resolve: (until: string | null) => void };
const request = signal<Request | null>(null);

const mode = signal<"date" | "duration">("date");
const date = signal("");
const time = signal("");
const amount = signal("2");
const unit = signal<"minutes" | "hours" | "days">("hours");
const problem = signal("");

/** Opens the dialog; resolves to the wake time or null when cancelled. */
export function requestCustomSnooze(): Promise<string | null> {
  request()?.resolve(null);
  const initial = new Date(Date.now() + 3_600_000);
  mode.set("date");
  date.set(localSnoozeDate(initial));
  time.set(localSnoozeTime(initial));
  amount.set("2");
  unit.set("hours");
  problem.set("");
  return new Promise((resolve) => request.set({ resolve }));
}

function finish(until: string | null) {
  const open = request();
  request.set(null);
  open?.resolve(until);
}

function submit() {
  const input: CustomSnoozeInput = mode() === "date"
    ? { mode: "date", date: date().trim(), time: time().trim() }
    : { mode: "duration", amount: amount(), unit: unit() };
  const until = resolveCustomSnooze(input, new Date());
  if (!until) {
    problem.set(mode() === "date" ? "Choose a valid date and time in the future." : "Enter a positive duration.");
    return;
  }
  finish(until);
}

function Toggle(props: { label: string; on: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      class={`h-6 flex-1 items-center justify-center rounded-md px-2.5 ${props.on ? "bg-segmented-active" : "bg-transparent hover:bg-segmented-hover"}`}
    >
      <Text class={props.on ? "text-xs font-medium text-foreground" : "text-xs font-medium text-muted-foreground"}>{props.label}</Text>
    </View>
  );
}

function Field(props: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <View class="min-w-0 flex-1 gap-2">
      <Text class="text-sm font-medium text-foreground">{props.label}</Text>
      <Input
        accessibilityLabel={props.label}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => { props.onChange(event.value); problem.set(""); }}
        onSubmit={submit}
        class="h-8 rounded-lg border border-input bg-background px-3 text-sm text-foreground"
      />
    </View>
  );
}

/** The "Snooze for" NumberField (min 0, step "any"): Decrease duration, the amount, Increase duration; the arrows step it. */
function AmountField() {
  const current = () => { const parsed = Number(amount()); return amount().trim() !== "" && Number.isFinite(parsed) ? parsed : 0; };
  const set = (next: number) => { amount.set(String(Math.max(0, next))); problem.set(""); };
  const keys = createStepperKeys(current, set, () => ({ min: 0 }));
  const stepper = (label: string, src: typeof minusMark, by: number) => (
    <View role="button" accessibilityLabel={label} onPress={() => set(current() + by)} class="h-full items-center justify-center px-3 hover:bg-accent">
      <Image src={src} fadeDuration={0} style={{ width: 16, height: 16, tintColor: String(token("foreground")) }} />
    </View>
  );
  return (
    <View class="min-w-0 flex-1 gap-2">
      <Text class="text-sm font-medium text-foreground">Snooze for</Text>
      <View class="h-8 flex-row items-center overflow-hidden rounded-lg border border-input bg-background">
        {stepper("Decrease duration", minusMark, -1)}
        <Input
          accessibilityLabel="Snooze for"
          value={amount()}
          keyboardType="decimal-pad"
          onChange={(event) => { amount.set(event.value); problem.set(""); }}
          onFocus={keys.onFocus}
          onBlur={keys.onBlur}
          onSubmit={submit}
          class="h-8 min-w-0 flex-1 px-1 text-center text-sm text-foreground"
        />
        {stepper("Increase duration", plusMark, 1)}
      </View>
    </View>
  );
}

export function CustomSnoozeDialogHost() {
  useOverlayOpen(() => request() !== null, "custom snooze dialog", DIALOG_MS);
  return (
    <Dialog
      open={request() !== null}
      animation="fade"
      onOpenChange={({ open }) => { if (!open) finish(null); }}
      backdropStyle={dialogBackdropStyle()}
      style={[{ margin: "auto", width: 384, maxWidth: "90%" }, dialogPopupMotion(() => request() !== null)]}
    >
      <View class="relative gap-4 rounded-2xl border border-border bg-background p-6" onPress={keepPressInDialog}>
        <DialogCloseButton onClose={() => finish(null)} />
        <View class="gap-1">
          <Text class="text-lg font-semibold text-foreground">Custom snooze</Text>
          <Text class="text-sm text-muted-foreground">Choose when snoozed threads return to your inbox.</Text>
        </View>
        <View class="flex-row gap-0.5 rounded-lg bg-segmented-track p-0.5">
          <Toggle label="Date and time" on={mode() === "date"} onPress={() => { mode.set("date"); problem.set(""); }} />
          <Toggle label="Duration" on={mode() === "duration"} onPress={() => { mode.set("duration"); problem.set(""); }} />
        </View>
        {mode() === "date" ? (
          <View class="flex-row gap-3">
            {/* The Date button opens the month grid (ui/calendar.tsx); days before today are disabled. */}
            <SnoozeDateField
              value={parseLocalDate(date()) ?? new Date()}
              today={new Date()}
              onChange={(next) => { date.set(localSnoozeDate(next)); problem.set(""); }}
            />
            <Field label="Time" value={time()} onChange={(value) => time.set(value)} placeholder="HH:MM" />
          </View>
        ) : (
          <View class="flex-row gap-3">
            <AmountField />
            <View class="min-w-0 flex-1 gap-2">
              <Text class="text-sm font-medium text-foreground">Unit</Text>
              <View class="flex-row gap-1">
                {(["minutes", "hours", "days"] as const).map((choice) => (
                  <View
                    role="button"
                    accessibilityLabel={choice === "minutes" ? "Minutes" : choice === "hours" ? "Hours" : "Days"}
                    onPress={() => { unit.set(choice); problem.set(""); }}
                    class={`h-8 flex-1 items-center justify-center rounded-lg border border-input ${unit() === choice ? "bg-accent" : "bg-background"}`}
                  >
                    <Text class="text-xs text-foreground">{choice === "minutes" ? "Min" : choice === "hours" ? "Hrs" : "Days"}</Text>
                  </View>
                ))}
              </View>
            </View>
          </View>
        )}
        {problem() ? <Text class="text-sm text-destructive-foreground">{problem()}</Text> : null}
        <View class="flex-row justify-end gap-2">
          <View role="button" accessibilityLabel="Cancel" onPress={() => finish(null)} class="h-8 items-center justify-center rounded-lg border border-input bg-background px-4">
            <Text class="text-sm font-medium text-foreground">Cancel</Text>
          </View>
          <View role="button" accessibilityLabel="Snooze" onPress={submit} class="h-8 items-center justify-center rounded-lg bg-primary px-4 active:scale-[0.97] transition-transform duration-150 ease-in-out">
            <Text class="text-sm font-medium text-primary-foreground">Snooze</Text>
          </View>
        </View>
      </View>
    </Dialog>
  );
}
