// The number field's keys (ui/number-field.tsx over Base UI's NumberField.Input): while the field has the focus,
// ArrowUp / ArrowDown step by `step`, with Shift by `largeStep` (Base UI's default 10), and Home / End jump to the
// minimum / maximum when the field has one. Bound only while the field is focused, and released when it blurs or
// unmounts, so a field removed while focused leaves no arrow bindings behind.
import { cleanup, keymap } from "nsh";

export interface StepperKeyOptions {
  step?: number;
  largeStep?: number;
  min?: number;
  max?: number;
}

export type StepperKey = "up" | "down" | "shift+up" | "shift+down" | "home" | "end";

/** The value a key moves `current` to, clamped to min/max, or null when the key does nothing for this field. */
export function stepperKeyValue(key: StepperKey, current: number, options: StepperKeyOptions = {}): number | null {
  const step = options.step ?? 1;
  const large = options.largeStep ?? 10;
  const clamp = (value: number) => Math.min(options.max ?? Infinity, Math.max(options.min ?? -Infinity, value));
  switch (key) {
    case "up": return clamp(current + step);
    case "down": return clamp(current - step);
    case "shift+up": return clamp(current + large);
    case "shift+down": return clamp(current - large);
    case "home": return options.min === undefined ? null : options.min;
    case "end": return options.max === undefined ? null : options.max;
  }
}

/** The keys a field with these bounds takes: Home / End only when that bound is defined. */
export function stepperKeys(options: StepperKeyOptions = {}): StepperKey[] {
  const keys: StepperKey[] = ["up", "down", "shift+up", "shift+down"];
  if (options.min !== undefined) keys.push("home");
  if (options.max !== undefined) keys.push("end");
  return keys;
}

/**
 * Focus handlers for a stepper's Input: on focus they bind the stepper keys (in the input too, repeating while held)
 * to `onStep(next)`, where `next` comes from `current()` (the parsed draft when there is one); on blur they release them.
 */
export function createStepperKeys(current: () => number, onStep: (next: number) => void, options: () => StepperKeyOptions = () => ({})) {
  let release: (() => void) | null = null;
  const off = () => { release?.(); release = null; };
  cleanup(off);
  return {
    onFocus() {
      off();
      const bindings: Record<string, () => void> = {};
      for (const key of stepperKeys(options())) {
        bindings[key] = () => {
          const value = current();
          if (!Number.isFinite(value)) return;
          const next = stepperKeyValue(key, value, options());
          if (next !== null && next !== value) onStep(next);
        };
      }
      release = keymap.bind(bindings, { when: "always", repeat: true });
    },
    onBlur: off,
  };
}
