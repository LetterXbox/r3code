// Warms the usage-summary cache in the background a few seconds after the backend connects and the app is
// idle, so the server's cold scan (~10s) has already happened by the time the user opens the Usage page.
// Runs once per session, the current period first, then the other 3 standard periods one at a time; never
// while disconnected or while a thread is streaming a turn, and never polls (loadUsageSummary already
// respects the 60s staleness, so a repeat call here would be a no-op network-wise, but we still only try once).
import { effect } from "nsh";
import { usageWindow } from "../../pages/utility-data";
import { loadUsageSummary } from "./usageCache";

/** 1 / 7 / 30 / 90 days: the Usage page's own Segmented period options. */
export const STANDARD_USAGE_PERIODS = [1, 7, 30, 90];

export interface UsagePrewarmDeps {
  isConnected: () => boolean;
  isIdle: () => boolean;
  environments: () => { id: string; connected: boolean }[];
  defaultPeriodDays: () => number;
  delayMs?: number;
}

let started = false;
let ran = false;

/** Test hook: let a later test schedule (and run) the prewarm again as if a fresh session. */
export function resetUsagePrewarmForTest() { started = false; ran = false; }

async function runPrewarm(deps: UsagePrewarmDeps) {
  const targets = deps.environments().filter((env) => env.connected);
  if (targets.length === 0) return;
  const defaultDays = deps.defaultPeriodDays();
  // Only the period the page will open on. Warming all four meant minutes of transcript scanning on a machine with a
  // large history (a 30 or 90 day scan of ~5,000 sessions), every session, for periods that may never be looked at.
  const periods = [defaultDays];
  for (const days of periods) {
    const window = usageWindow(days);
    for (const target of targets) {
      try { await loadUsageSummary(target.id, window); } catch { /* best effort: the page will read it normally when opened */ }
    }
  }
}

/**
 * Registers the reactive watch that fires the (once-per-session) prewarm. Call once from an always-mounted
 * component (the Usage page itself is mounted for the app's lifetime); `effect` disposes with that component.
 */
export function scheduleUsagePrewarm(deps: UsagePrewarmDeps): void {
  if (started) return;
  started = true;
  const delayMs = deps.delayMs ?? 3000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  effect(() => {
    const connected = deps.isConnected();
    const idle = deps.isIdle();
    if (timer) { clearTimeout(timer); timer = null; }
    if (ran || !connected || !idle) return;
    timer = setTimeout(() => {
      timer = null;
      if (ran || !deps.isConnected() || !deps.isIdle()) return;
      ran = true;
      void runPrewarm(deps);
    }, delayMs);
  });
}
