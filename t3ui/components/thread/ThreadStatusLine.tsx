// chat/ThreadStatusLine.tsx and the settled branch of useThreadLifecycle.tsx: the line at the end of the
// timeline: "Snoozed, 3h left · Wake now" (thread.unsnooze), "Settled just now · Un-settle" (thread.unsettle), and
// "Woke from snooze · Dismiss" (a visit at the wake time), in that precedence.
import { effect, signal, Text, View } from "nsh";
import { createHover } from "../hoverReveal";
import { Glyph } from "../sidebar/SidebarGlyph";
import { chatWidthClass } from "./layout";
import { backendStatus, openThread } from "../../store";
import { acknowledgeThreadWoke, threadActionNotice, unsettleThread, unsnoozeThread } from "../sidebar/threadActions";
import { isSnoozed, snoozeWakeLabel, threadWokeAt } from "../sidebar/threadStatus";
import { limitRecoveryActive, limitRecoveryOwnsSnooze } from "../banners/bannerLogic";
import type { Thread } from "../../store";

/** timestampFormat.formatRelativeElapsed + formatRelativeTimeLabel: "just now", "5m ago", "3h ago", "2d ago". */
export function relativeTimeLabel(elapsedMs: number): string {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The label of the settled line: "Settled" alone while the shell has no settledAt. */
export function settledLabel(settledAt: number | null | undefined, now: number): string {
  return settledAt ? `Settled ${relativeTimeLabel(now - settledAt)}` : "Settled";
}

/** Whether the open thread's status line is the settled one (useThreadLifecycle: settledOverride === "settled"). */
export const threadSettled = () => openThread()?.meta?.settled === true;

/** "Snoozed, 3h left", or "Snoozed" once the wake label reads "now". */
export function snoozedLabel(until: number | null | undefined, now: number): string {
  const wake = until != null ? snoozeWakeLabel(until, now) : null;
  return wake && wake !== "now" ? `Snoozed, ${wake} left` : "Snoozed";
}

/** isThreadWokeUnseen: woke, not settled, and neither visited nor finished a run since the wake. */
export function wokeUnseen(thread: Thread, now: number): number | null {
  const wokeAt = threadWokeAt(thread, now);
  if (wokeAt === null || thread.meta?.settled) return null;
  const seen = [thread.meta?.lastVisitedAt, thread.meta?.latestRunCompletedAt].filter((value): value is number => typeof value === "number");
  return seen.every((at) => at < wokeAt) ? wokeAt : null;
}

/** limitRecoveryHoldsSnooze: the usage-limit recovery banner shows this snooze and its own Wake now. */
function recoveryHoldsSnooze(thread: Thread): boolean {
  const info = thread.banner;
  if (!info || !limitRecoveryActive(info)) return false;
  return limitRecoveryOwnsSnooze({ runId: info.latestRunId, resetAt: info.usageLimitResetAt, recovery: info.limitRecovery, snoozedUntil: info.snoozedUntil });
}

export type ThreadStatusKind = "snoozed" | "settled" | "woke" | null;

export function threadStatusKind(thread: Thread | null | undefined, now: number): ThreadStatusKind {
  if (!thread) return null;
  if (isSnoozed(thread, now)) return recoveryHoldsSnooze(thread) ? null : "snoozed";
  if (thread.meta?.settled === true) return "settled";
  return wokeUnseen(thread, now) !== null ? "woke" : null;
}

export function ThreadStatusLine(props: { now?: () => number; unsettle?: (id: string) => Promise<unknown>; unsnooze?: (id: string) => Promise<unknown>; acknowledgeWoke?: (id: string, wokeAt: number) => Promise<unknown>; /** Test seam for the connection state. */ connected?: () => boolean }) {
  // The snooze label reads the current minute (seconds dropped), as useThreadLifecycle and the sidebar shelf round.
  const clock = signal(Date.now());
  effect(() => {
    if (props.now) return;
    const timer = setInterval(() => clock.set(Date.now()), 5_000);
    return () => clearInterval(timer);
  });
  const now = () => (props.now ? props.now() : clock());
  const busy = signal(false);
  const unsettleHover = createHover();
  const wakeHover = createHover();
  const dismissHover = createHover();
  const waking = signal(false);
  const kind = () => threadStatusKind(openThread(), now());
  const canAct = () => (props.connected ? props.connected() : backendStatus() === "connected") && !busy();
  const unsettle = () => {
    const id = openThread()?.id;
    if (!id || !canAct()) return;
    busy.set(true);
    void (props.unsettle ?? unsettleThread)(id)
      .catch((error: unknown) => threadActionNotice.show(error instanceof Error ? error.message : "Failed to un-settle thread"))
      .finally(() => busy.set(false));
  };
  const wake = () => {
    const id = openThread()?.id;
    if (!id || !canAct() || waking()) return;
    waking.set(true);
    void (props.unsnooze ?? unsnoozeThread)(id)
      .catch((error: unknown) => threadActionNotice.show(error instanceof Error ? error.message : "Failed to wake thread"))
      .finally(() => waking.set(false));
  };
  const dismissWoke = () => {
    const thread = openThread();
    const wokeAt = thread ? wokeUnseen(thread, now()) : null;
    if (!thread || wokeAt === null) return;
    void (props.acknowledgeWoke ?? acknowledgeThreadWoke)(thread.id, wokeAt).catch(() => {});
  };
  return (
    <View class="shrink-0">
    {kind() === "snoozed" ? (
    <View class="px-3">
      <View class={`mx-auto w-full ${chatWidthClass()} min-w-0 flex-row items-center gap-1.5 px-1 pb-2`} accessibilityLabel="Thread status">
        <Glyph name="alarm-clock" size={14} />
        <Text class="min-w-0 truncate text-xs text-muted-foreground">{snoozedLabel(openThread()?.meta?.snoozedUntil, Math.floor(now() / 60_000) * 60_000)}</Text>
        <Text class="text-xs text-muted-foreground">·</Text>
        <View onPress={wake} disabled={!canAct() || waking()} accessibilityLabel="Wake now" role="button" {...wakeHover.bind}>
          <Text class={`text-xs font-medium text-foreground ${wakeHover.hovered() ? "underline" : ""}`}>{waking() ? "Waking..." : "Wake now"}</Text>
        </View>
      </View>
    </View>
    ) : null}
    {kind() === "woke" ? (
    <View class="px-3">
      <View class={`mx-auto w-full ${chatWidthClass()} min-w-0 flex-row items-center gap-1.5 px-1 pb-2`} accessibilityLabel="Thread status">
        <Glyph name="alarm-clock" size={14} />
        <Text class="min-w-0 truncate text-xs text-muted-foreground">Woke from snooze</Text>
        <Text class="text-xs text-muted-foreground">·</Text>
        <View onPress={dismissWoke} accessibilityLabel="Dismiss" role="button" {...dismissHover.bind}>
          <Text class={`text-xs font-medium text-foreground ${dismissHover.hovered() ? "underline" : ""}`}>Dismiss</Text>
        </View>
      </View>
    </View>
    ) : null}
    {kind() === "settled" ? (
    <View class="px-3">
      <View class={`mx-auto w-full ${chatWidthClass()} min-w-0 flex-row items-center gap-1.5 px-1 pb-2`} accessibilityLabel="Thread status">
        <Glyph name="circle-check" size={14} />
        <Text class="min-w-0 truncate text-xs text-muted-foreground">{settledLabel(openThread()?.meta?.settledAt, now())}</Text>
        <Text class="text-xs text-muted-foreground">·</Text>
        <View onPress={unsettle} disabled={!canAct()} accessibilityLabel="Un-settle" role="button" {...unsettleHover.bind}>
          <Text class={`text-xs font-medium text-foreground ${unsettleHover.hovered() ? "underline" : ""}`}>{busy() ? "Un-settling..." : "Un-settle"}</Text>
        </View>
      </View>
    </View>
    ) : null}
    </View>
  );
}
