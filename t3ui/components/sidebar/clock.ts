// One minute tick shared by the sidebar: relative times, snooze wake labels and the moment a
// snooze expires and its thread returns to the list.
import { effect, signal } from "nsh";

const clock = signal(Date.now());
setInterval(() => clock.set(Date.now()), 60_000);

export const minuteNow = () => clock();

// A one second tick for the Working duration labels (useNowSecond). It starts when the first label
// reads it, so a sidebar with no working rows costs nothing.
const secondClock = signal(Date.now());
let secondTimer: ReturnType<typeof setInterval> | undefined;
export const secondNow = () => {
  secondTimer ??= setInterval(() => secondClock.set(Date.now()), 1000);
  return secondClock();
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** msUntilRelativeTimeChange (timestampFormat.ts:249-260): when a "now / 5m / 3h / 2d" label of `timestamp` next changes,
 * capped at a day so a timer never overflows. */
export function msUntilRelativeTimeChange(timestamp: number, now: number): number {
  const elapsed = Math.max(0, now - timestamp);
  const unit = elapsed < HOUR_MS ? MINUTE_MS : elapsed < DAY_MS ? HOUR_MS : DAY_MS;
  return Math.max(1, Math.min(timestamp + (Math.floor(elapsed / unit) + 1) * unit - now, DAY_MS));
}

/** useRelativeTimeState: a clock for one relative label that ticks exactly when the label's text changes (instead of on
 * the shared minute tick, which could leave it up to a minute behind). Call it in a component. */
export function relativeTimeNow(timestamp: () => number): () => number {
  const now = signal(Date.now());
  effect(() => {
    const at = timestamp();
    if (!Number.isFinite(at)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const current = Date.now();
      now.set(current);
      timer = setTimeout(schedule, msUntilRelativeTimeChange(at, current));
    };
    timer = setTimeout(schedule, msUntilRelativeTimeChange(at, Date.now()));
    return () => clearTimeout(timer);
  });
  return () => Math.max(now(), minuteNow());
}
