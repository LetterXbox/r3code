// PullRequestChangeBreakdownStat.tsx: the pull request's +/- stat, whose tooltip splits it into Code, Tests, Mocks,
// Generated and Docs (pullRequests.changeBreakdown) with the Total. A list row reads the split on first hover only;
// a view of one pull request passes `eager` so it is ready before the hover.
import { signal, Text, View } from "nsh";
import { Tooltip } from "nsh/base";
import { diffAdditionClass, diffDeletionClass } from "../diff/diffColorScheme";

const KIND_LABELS = { code: "Code", tests: "Tests", mocks: "Mocks", generated: "Generated", docs: "Docs" } as const;
const formatCount = (count: number) => new Intl.NumberFormat().format(count);
type Kind = keyof typeof KIND_LABELS;
export type ChangeBreakdown = Record<Kind, { additions: number; deletions: number }>;

/** PullRequestChangeBreakdown (null when the host cannot split it); a server from before the docs split sends no docs. */
export function parseChangeBreakdown(value: unknown): ChangeBreakdown | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const count = (entry: unknown) => {
    const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    return { additions: typeof e.additions === "number" ? e.additions : 0, deletions: typeof e.deletions === "number" ? e.deletions : 0 };
  };
  if (v.code === undefined) return null;
  return { code: count(v.code), tests: count(v.tests), mocks: count(v.mocks), generated: count(v.generated), docs: count(v.docs) };
}

/** The rows the tooltip shows: the kinds that changed, in order. */
export function breakdownRows(breakdown: ChangeBreakdown): { label: string; additions: number; deletions: number }[] {
  return (Object.keys(KIND_LABELS) as Kind[]).flatMap((kind) => (breakdown[kind].additions === 0 && breakdown[kind].deletions === 0 ? [] : [{ label: KIND_LABELS[kind], ...breakdown[kind] }]));
}

/** state/pullRequests.ts changeBreakdown: a query with a 60 s stale time, not one answer per app run. */
const CHANGE_BREAKDOWN_STALE_MS = 60_000;
const cache = new Map<string, { at: number; value: Promise<ChangeBreakdown | null> }>();

/** Shared 3-column breakdown table used both on PR rows and the floating Changes tooltip (#26566). */
export function ChangeBreakdownTooltipContent(props: { breakdown: ChangeBreakdown; total?: { additions: number; deletions: number } }) {
  const row = (label: string, additions: number, deletions: number) => (
    <View class="flex-row gap-4">
      <Text class="w-20 text-xs text-popover-foreground">{label}</Text>
      <Text class={`w-12 text-right font-mono text-xs ${diffAdditionClass("text-success-foreground")}`}>{`+${formatCount(additions)}`}</Text>
      <Text class={`w-12 text-right font-mono text-xs ${diffDeletionClass("text-destructive")}`}>{`-${formatCount(deletions)}`}</Text>
    </View>
  );
  return (
    <Tooltip class="rounded-md border border-border bg-popover px-2 py-1">
      <View class="gap-1 py-0.5">
        {breakdownRows(props.breakdown).map((entry) => row(entry.label, entry.additions, entry.deletions))}
        {props.total ? (
          <>
            <View class="h-px bg-border" />
            {row("Total", props.total.additions, props.total.deletions)}
          </>
        ) : null}
      </View>
    </Tooltip>
  );
}

export function PullRequestChangeBreakdownStat(props: {
  reference: { projectId: string; host?: string; repository: string; number: number };
  additions: number;
  deletions: number;
  request: (method: string, payload: unknown) => Promise<unknown>;
  size?: "xs" | "2xs";
  eager?: boolean;
}) {
  const breakdown = signal<ChangeBreakdown | null>(null);
  const state = signal<"idle" | "loading" | "done">("idle");
  const key = JSON.stringify([props.reference.projectId, props.reference.host ?? null, props.reference.repository.toLowerCase(), props.reference.number, props.additions, props.deletions]);
  function request() {
    const hit = cache.get(key);
    const fresh = hit !== undefined && Date.now() - hit.at < CHANGE_BREAKDOWN_STALE_MS;
    if (state() === "loading" || (state() === "done" && fresh)) return;
    state.set("loading");
    let pending = fresh ? hit!.value : undefined;
    if (!pending) {
      const next = props.request("pullRequests.changeBreakdown", props.reference).then(parseChangeBreakdown);
      next.catch(() => { if (cache.get(key)?.value === next) cache.delete(key); });
      cache.set(key, { at: Date.now(), value: next });
      pending = next;
    }
    void pending.then((value) => breakdown.set(value)).catch(() => {}).finally(() => state.set("done"));
  }
  if (props.eager) request();
  if (props.additions === 0 && props.deletions === 0) return null;
  const text = props.size === "2xs" ? "text-2xs" : "text-xs";
  const tip = () => breakdown()
    ? <ChangeBreakdownTooltipContent breakdown={breakdown()!} total={{ additions: props.additions, deletions: props.deletions }} />
    : state() === "loading"
      ? <Tooltip class="rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">Loading breakdown</Text></Tooltip>
      : undefined;
  return (
    <View class="shrink-0 flex-row items-baseline gap-1.5" onMouseEnter={request} {...(tip() ? { tooltip: tip() } : {})} accessibilityLabel={`${props.additions} additions, ${props.deletions} deletions`}>
      <Text class={`font-mono ${text} ${diffAdditionClass("text-success")}`}>{`+${formatCount(props.additions)}`}</Text>
      <Text class={`font-mono ${text} ${diffDeletionClass("text-destructive")}`}>{`-${formatCount(props.deletions)}`}</Text>
    </View>
  );
}
