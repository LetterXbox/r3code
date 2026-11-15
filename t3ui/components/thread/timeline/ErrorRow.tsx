// TimelineWorkEntryRow.tsx, failed `error` turn item: a usage limit reads "Usage limit reached. Retry after <time> (<zone>)."
// in the warning colour; any other failure shows its label in the destructive colour with the failure message below, and
// a failed workspace preparation offers Retry (`prepared-run.retry`, client-runtime retryWorkspacePreparation).
import { Image, signal, Text, View } from "nsh";
import { requestBackend, threadRuns } from "../../../store";
import { chatWidthClass } from "../layout";
import { TimelineIcon } from "../markdown/TimelineIcon";
import { TimelineRowTimestamp } from "./TimelineRowParts";
import { createHover } from "../../hoverReveal";
import { tokenTint } from "../../composer/tokenColor";
import rotateCcw from "../../../icons/rotate-ccw.svg";
import type { WorkItem } from "./workLog";

type Rec = Record<string, unknown>;
/** ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE. */
export const WORKSPACE_PREPARATION_FAILURE_CODE = "workspace_preparation_failed";

/** formatUpcomingTimestamp (timestampFormat.ts): today's time, "tomorrow at <time>", else the date and time. */
export function formatUpcomingTimestamp(iso: string, now = Date.now(), timeZone?: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(date);
  const day = (value: Date) => { const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(value); return Date.parse(`${parts}T00:00:00Z`) / 86_400_000; };
  const diff = day(date) - day(new Date(now));
  if (diff === 0) return time;
  if (diff === 1) return `tomorrow at ${time}`;
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const dateText = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), ...(timeZone ? { timeZone } : {}) }).format(date);
  return `${dateText} ${time}`;
}

/** The row's label: the usage-limit copy with its reset time, else the work entry's own label. */
export function failureLabel(item: Rec, fallback: string, now = Date.now()): { label: string; warning: boolean } {
  const failure = (item.failure ?? {}) as Rec;
  if (failure.class !== "usage_limit") return { label: fallback, warning: false };
  const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const reset = typeof failure.resetAt === "string" ? formatUpcomingTimestamp(failure.resetAt, now, zone) : "";
  return { label: `Usage limit reached.${reset ? ` Retry after ${reset} (${zone}).` : ""}`, warning: true };
}

/** workspacePreparationRetryRunIds: a failed run that prepared a workspace, failed with the preparation code. */
export function retryableRunId(item: Rec, runs: readonly Rec[]): string | null {
  const failure = (item.failure ?? {}) as Rec;
  const runId = typeof item.runId === "string" ? item.runId : null;
  if (!runId || item.status !== "failed" || failure.code !== WORKSPACE_PREPARATION_FAILURE_CODE) return null;
  return runs.some((run) => run.id === runId && run.status === "failed" && run.workspacePreparation !== undefined) ? runId : null;
}

const retrying = new Set<string>();

export function ErrorRow(props: { item: () => WorkItem; runs?: () => readonly Rec[]; send?: (method: string, payload: unknown) => Promise<unknown> }) {
  const raw = () => (props.item().item ?? {}) as Rec;
  const presentation = () => failureLabel(raw(), props.item().title);
  const message = () => String(((raw().failure ?? {}) as Rec).message ?? "");
  const runId = () => retryableRunId(raw(), props.runs?.() ?? threadRuns());
  const busy = signal(false);
  const hover = createHover();
  const retry = () => {
    const id = runId();
    const threadId = typeof raw().threadId === "string" ? String(raw().threadId) : "";
    if (!id || !threadId || retrying.has(id)) return;
    retrying.add(id);
    busy.set(true);
    void (props.send ?? requestBackend)("orchestration.dispatchCommand", { type: "prepared-run.retry", commandId: `command:${crypto.randomUUID()}`, threadId, runId: id })
      .catch(() => undefined)
      .finally(() => { retrying.delete(id); busy.set(false); });
  };
  return (
    <View class={`mx-auto w-full ${chatWidthClass()} py-0.5`} accessibilityLabel={presentation().label}>
      <View class="min-h-6 flex-row items-start gap-1.5" {...hover.bind}>
        <View class="size-6 shrink-0 items-center justify-center">
          <TimelineIcon name="circle-alert" size={16} tint={tokenTint(presentation().warning ? "warning" : "destructive")} />
        </View>
        <Text class={`min-w-0 flex-1 text-sm font-medium leading-relaxed ${presentation().warning ? "text-warning-foreground" : "text-destructive"}`}>{presentation().label}</Text>
        <TimelineRowTimestamp createdAt={() => props.item().startedAt ?? props.item().order} hovered={hover.hovered} />
      </View>
      {!presentation().warning && message() ? (
        <View class="ms-7 py-1" selectable><Text class="text-sm leading-relaxed text-foreground">{message()}</Text></View>
      ) : null}
      {runId() !== null ? (
        <View class="ms-7 pb-1 flex-row">
          <View class="h-6 flex-row items-center gap-1 rounded-md border border-input px-2 hover:bg-accent" onPress={retry} disabled={busy()} accessibilityLabel="Retry" role="button">
            <Image src={rotateCcw} style={{ width: 12, height: 12, tintColor: tokenTint("foreground") }} />
            <Text class="text-xs text-foreground">Retry</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}
