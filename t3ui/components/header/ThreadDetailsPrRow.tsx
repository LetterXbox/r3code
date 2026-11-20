// chat/ThreadDetailsPrRow.tsx: one linked change request in the thread details card. With the live detail
// (pullRequests.detail, re-read every 10 minutes while open, and every 45 s / 60 s while its checks run), the row shows
// the title (two lines), "#N", the checks count, the stop-watching eye and one trailing action: Resolve (conflicts, a new
// thread), Ready (mark ready), Fix (failing checks, a new thread) or Merge (after a confirmation). The hover card shows the
// title, state, base <- head, checks, the draft conflict warning, and the file count with its diff stat. Without a detail
// the row is the plain state glyph + label.
import { colorScheme, effect, openUrl, signal, Text, View } from "nsh";
import { Popover } from "nsh/base";
import { trackOpenChange, useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { PRIcon } from "../pullRequest/PRIcon";
import { resolveState, toneColor } from "../pullRequest/pullRequestPresentation";
import { CHECK_STATUS, parseDetail, parseDetailCheck, type DetailCheck, type PullRequestDetailData } from "../pullRequest/pullRequestDetail.logic";
import { parsePullRequestChecks, resolvePullRequestDetailChecks, usePullRequestRefreshes } from "../pullRequest/pullRequestState";
import { allowedMergeMethods, canPerform, classifyChecks, describeChecks, groupChecks, resolveMergeMethod } from "../pullRequest/pullRequestActions.logic";
import { createPullRequestActionsModel } from "../pullRequest/pullRequestActionsModel";
import { createPullRequestHandoffModel } from "../pullRequest/pullRequestHandoffModel";
import { createPullRequestCheckoutModel } from "../pullRequest/pullRequestCheckoutModel";
import { changeRequestTerm } from "../pullRequest/pullRequestCheckout.logic";
import { openPullRequestSurface } from "../rightPanel/panelState";
import { confirm } from "../toast/confirmDialog";
import { showToast, updateToast } from "../toast";
import { createHover } from "../hoverReveal";
import { HIcon } from "./HeaderIcons";
import { Icon } from "../Icons";
import type { LinkedPullRequest } from "./threadRelations";
import { allProjects, backendStatus, createThread, openThread, requestBackend, setComposerDraft, setWorkspaceStrategy, subscribeBackend, supportsPullRequestChecks } from "../../store";

type Request = (method: string, payload: unknown) => Promise<unknown>;
export type ThreadPanelPullRequestAction = "resolve" | "ready" | "fix" | "merge";

export const PR_DETAIL_REFRESH_MS = 10 * 60_000;

/** pullRequestChecksRefreshIntervalMs: 45 s while checks run (or none are reported yet), else 60 s. */
export function checksRefreshIntervalMs(checks: readonly DetailCheck[]): number {
  return checks.length === 0 || checks.some((check) => check.status === "pending" || check.status === "action-required") ? 45_000 : 60_000;
}

/** resolveThreadPanelPullRequestAction: the one trailing action an open change request offers. */
export function threadPanelPullRequestAction(detail: PullRequestDetailData | null): ThreadPanelPullRequestAction | null {
  if (detail === null || detail.state !== "open") return null;
  if (detail.mergeability === "conflicting") return "resolve";
  if (detail.isDraft) return canPerform(detail, "ready") ? "ready" : null;
  const checks = classifyChecks(detail.checks);
  if (checks === "failing") return "fix";
  if (checks === "pending") return null;
  return canPerform(detail, "merge") && allowedMergeMethods(detail).length > 0 ? "merge" : null;
}

/** The trailing action's copy (label, pending label, tooltip), as the reference writes it. */
export function trailingActionCopy(action: ThreadPanelPullRequestAction, term: string, method: string) {
  switch (action) {
    case "resolve": return { label: "Resolve", pendingLabel: "Preparing...", destructive: true, tooltip: "Check the branch out and resolve the conflicts in a new thread" };
    case "ready": return { label: "Ready", pendingLabel: "Marking...", destructive: false, tooltip: `Mark this ${term} as ready for review` };
    case "fix": return { label: "Fix", pendingLabel: "Preparing...", destructive: true, tooltip: "Fix the failing checks in a new thread" };
    case "merge": return { label: "Merge", pendingLabel: "Merging...", destructive: false, tooltip: `Merge this ${term} (${method})` };
  }
}

/** The checks count chip: passed/total. */
export function checksCountLabel(checks: readonly DetailCheck[]): string {
  return `${checks.filter((check) => check.status === "success").length}/${checks.length}`;
}

const BREAKDOWN_KINDS = [["code", "Code"], ["tests", "Tests"], ["mocks", "Mocks"], ["generated", "Generated"], ["docs", "Docs"]] as const;
export type ChangeBreakdown = Partial<Record<(typeof BREAKDOWN_KINDS)[number][0], { additions: number; deletions: number }>>;

/** PullRequestChangeBreakdownRows: the split of the diff stat into code, tests, mocks, generated and docs (rows with changes). */
export function breakdownRows(breakdown: ChangeBreakdown | null): { label: string; additions: number; deletions: number }[] {
  if (!breakdown) return [];
  return BREAKDOWN_KINDS.flatMap(([kind, label]) => {
    const entry = breakdown[kind];
    return entry && (entry.additions > 0 || entry.deletions > 0) ? [{ label, additions: entry.additions, deletions: entry.deletions }] : [];
  });
}

function HoverCard(props: { detail: PullRequestDetailData; breakdown?: ChangeBreakdown | null }) {
  const state = resolveState({ state: props.detail.state, isDraft: props.detail.isDraft });
  const checks = classifyChecks(props.detail.checks);
  const conflicting = props.detail.state === "open" && props.detail.mergeability === "conflicting";
  return (
    <View class="max-w-80 gap-2 px-1 py-2">
      <View class="min-w-0 flex-row items-baseline gap-1.5">
        <Text class="min-w-0 truncate text-xs font-medium text-foreground">{props.detail.title}</Text>
        <Text class="shrink-0 text-xs text-muted-foreground">{`#${props.detail.number}`}</Text>
      </View>
      <View class="gap-1.5 pl-0.5">
        <View class="min-w-0 flex-row items-center gap-2">
          <PRIcon name={state.icon} size={12} tint={toneColor(state.tone, colorScheme())} />
          <Text class="min-w-0 truncate text-xs text-foreground">{state.label}</Text>
        </View>
        <View class="min-w-0 flex-row items-center gap-2">
          <PRIcon name="git-branch" size={12} />
          <Text class="min-w-0 truncate text-xs text-foreground">{`${props.detail.baseBranch} ← ${props.detail.headBranch}`}</Text>
        </View>
        {props.detail.state === "open" && checks !== "none" ? (
          <View class="min-w-0 flex-row items-center gap-2">
            <PRIcon name={checks === "failing" ? "circle-x" : checks === "pending" ? "circle-dot" : "circle-check"} size={12} />
            <Text class="min-w-0 truncate text-xs text-foreground">{describeChecks(props.detail.checks)}</Text>
          </View>
        ) : null}
        {props.detail.isDraft && conflicting ? (
          <View class="min-w-0 flex-row items-start gap-2">
            <PRIcon name="triangle-alert" size={12} />
            <Text class="min-w-0 flex-1 text-xs text-destructive">{`Merge conflicts with ${props.detail.baseBranch}`}</Text>
          </View>
        ) : null}
        <View class="min-w-0 flex-row items-center gap-2">
          <PRIcon name="file-diff" size={12} />
          <Text class="text-xs text-foreground">{`${props.detail.changedFiles.toLocaleString()} ${props.detail.changedFiles === 1 ? "file" : "files"}`}</Text>
          <Text class="text-xs text-success-foreground">{`+${props.detail.additions.toLocaleString()}`}</Text>
          <Text class="text-xs text-error-foreground">{`-${props.detail.deletions.toLocaleString()}`}</Text>
        </View>
        {breakdownRows(props.breakdown ?? null).length > 0 ? (
          <View class="gap-1 pl-5">
            {breakdownRows(props.breakdown ?? null).map((row) => (
              <View class="flex-row gap-4">
                <Text class="w-20 font-mono text-xs text-foreground">{row.label}</Text>
                <Text class="font-mono text-xs tabular-nums text-success-foreground">{`+${row.additions.toLocaleString()}`}</Text>
                <Text class="font-mono text-xs tabular-nums text-error-foreground">{`-${row.deletions.toLocaleString()}`}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** PullRequestChecksPopover: the summary, then the checks that need attention, the running ones, and the rest behind "Show all". */
function ChecksList(props: { checks: () => DetailCheck[] }) {
  const showAll = signal(false);
  const groups = () => groupChecks(props.checks());
  const canCollapse = () => groups().attention.length + groups().running.length > 0 && groups().completed.length > 0;
  const visible = () => [...groups().attention, ...groups().running, ...(showAll() || !canCollapse() ? groups().completed : [])];
  const tint = (status: string) => (status === "success" ? toneColor({ light: "#059669", dark: "#6ee7b7" }, colorScheme())
    : status === "failure" || status === "cancelled" ? toneColor({ light: "#dc2626", dark: "#f87171" }, colorScheme())
    : status === "pending" || status === "action-required" ? toneColor({ light: "#d97706", dark: "#fbbf24" }, colorScheme()) : undefined);
  return (
    <View class="gap-1" accessibilityLabel="Checks">
      <Text class="text-xs font-medium text-foreground">{describeChecks(props.checks())}</Text>
      <Each of={visible()} key={(check: DetailCheck, index: number) => `${index}:${check.name}`}>
        {(check) => {
          const status = CHECK_STATUS[check().status] ?? { label: check().status, icon: "circle-dashed" };
          return (
            <View class="flex-row items-center gap-2 py-0.5">
              <PRIcon name={status.icon} size={14} tint={tint(check().status)} />
              <Text class="min-w-0 flex-1 truncate text-xs text-foreground">{check().name}</Text>
              <Text class="text-xs text-muted-foreground">{status.label}</Text>
              {check().url ? <View accessibilityLabel={`Details for ${check().name}`} role="button" onPress={() => void openUrl(check().url)}><Text class="text-xs text-primary">Details</Text></View> : null}
            </View>
          );
        }}
      </Each>
      {canCollapse() ? (
        <View accessibilityLabel={showAll() ? "Show less" : "Show all"} role="button" onPress={() => showAll.update((value) => !value)} class="h-6 items-center justify-center rounded-md hover:bg-accent-50">
          <Text class="text-xs text-muted-foreground">{showAll() ? "Show less" : "Show all"}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function ThreadDetailsPrRow(props: {
  link: LinkedPullRequest;
  projectId: string;
  label: string;
  /** Stops watching this link (thread.pull-request.watch false); absent hides the eye. */
  onStopWatching?: () => void;
  /** Test seams. */
  request?: Request;
  confirmMerge?: (message: string) => Promise<boolean>;
  now?: () => number;
  /** environment.capabilities.pullRequestChecks; defaults to the connected environment's. */
  supportsChecks?: () => boolean;
}) {
  const request = props.request ?? requestBackend;
  const supportsChecks = props.supportsChecks ?? supportsPullRequestChecks;
  const ref = () => ({ projectId: props.projectId, ...(props.link.host ? { host: props.link.host } : {}), repository: props.link.repository, number: props.link.number });
  const detail = signal<PullRequestDetailData | null>(null);
  const load = async () => {
    if (!props.projectId) return;
    try {
      const parsed = parseDetail(await request("pullRequests.detail", ref()));
      detailAt = Date.now();
      detail.set(checksAnswer !== null && checksAnswer.at >= detailAt ? resolvePullRequestDetailChecks(parsed, checksAnswer.value, true) : parsed);
      if (checksAnswer === null) void loadChecks();
    } catch { /* the row stays on the linked snapshot */ }
  };
  // pullRequests.checks (gated on capabilities.pullRequestChecks), merged over the detail when newer; a null answer is
  // settled and stops the poll.
  let detailAt = 0;
  let checksAnswer: { value: NonNullable<ReturnType<typeof parsePullRequestChecks<DetailCheck>>>; at: number } | null = null;
  const checksSettledEmpty = signal(false);
  // Every checks read re-arms the poll at the cadence its answer calls for, even when the answer changes nothing.
  const checksTick = signal(0);
  const loadChecks = async () => {
    if (!supportsChecks() || detail() === null) return;
    try {
      const raw = await request("pullRequests.checks", ref());
      if (raw === null) { checksSettledEmpty.set(true); return; }
      const value = parsePullRequestChecks(raw, parseDetailCheck);
      if (!value) return;
      checksAnswer = { value, at: Date.now() };
      const current = detail();
      if (current) detail.set(resolvePullRequestDetailChecks(current, value, checksAnswer.at >= detailAt));
    } catch { /* the detail's own checks stay */ } finally { checksTick.update((value) => value + 1); }
  };
  effect(() => { void load(); });
  // PullRequestChangeBreakdownRows reads pullRequests.changeBreakdown once the detail shows a diff.
  const breakdown = signal<ChangeBreakdown | null>(null);
  let breakdownAsked = false;
  effect(() => {
    const current = detail();
    if (!current || breakdownAsked || (current.additions === 0 && current.deletions === 0)) return;
    breakdownAsked = true;
    void request("pullRequests.changeBreakdown", ref()).then((value) => { if (value && typeof value === "object") breakdown.set(value as ChangeBreakdown); }, () => {});
  });
  // useLiveRefresh (10 min) and usePullRequestChecksRefresh (45 s / 60 s) while the change request is open.
  effect(() => {
    const open = (detail()?.state ?? props.link.snapshot?.state ?? "open") === "open";
    if (!open) return;
    const timer = setTimeout(() => void load(), PR_DETAIL_REFRESH_MS);
    return () => clearTimeout(timer);
  });
  // refreshTrigger: the detail and checks re-read when the environment pushes a refresh (tests pass their own request).
  if (!props.request) usePullRequestRefreshes({ environmentId: () => "primary", connected: () => backendStatus() === "connected" && props.projectId !== "", subscribe: subscribeBackend, onRefresh: () => void load().then(() => loadChecks()) });
  effect(() => {
    const current = detail();
    void checksTick();
    if (!current || current.state !== "open" || !supportsChecks() || checksSettledEmpty()) return;
    const timer = setTimeout(() => void loadChecks(), checksRefreshIntervalMs(current.checks));
    return () => clearTimeout(timer);
  });
  const term = () => changeRequestTerm(detail()?.provider ?? "github");
  const actions = createPullRequestActionsModel({ request, ref, refresh: load, allowedMethods: () => allowedMergeMethods(detail()), term });
  const checkout = createPullRequestCheckoutModel({
    request,
    subject: () => { const current = detail(); return current ? { url: current.url, projectId: props.projectId, term: term() } : null; },
    projectPath: (projectId) => allProjects().find((project) => project.id === projectId)?.path ?? null,
    newThread: (projectId) => { createThread(projectId); return openThread()?.id ?? null; },
    selectWorkspace: (workspace) => setWorkspaceStrategy(workspace),
    toasts: { show: showToast, update: updateToast },
  });
  const handoff = createPullRequestHandoffModel({
    subject: () => { const current = detail(); return current ? { number: current.number, title: current.title, url: current.url, headBranch: current.headBranch, baseBranch: current.baseBranch, provider: current.provider, projectId: props.projectId } : null; },
    newThread: (projectId) => { createThread(projectId); return openThread()?.id ?? null; },
    setDraft: (text) => setComposerDraft(text),
    checkout: (mode, withTask) => checkout.start(mode, withTask),
    toast: (input) => { showToast(input); },
  });
  const action = () => threadPanelPullRequestAction(detail());
  const method = () => resolveMergeMethod(allowedMergeMethods(detail()), actions.chosenMethod());
  const conflicting = () => detail()?.state === "open" && detail()?.mergeability === "conflicting";
  const showChecks = () => { const current = detail(); return current !== null && current.checks.length > 0 && !conflicting() && !current.isDraft; };
  const watching = () => props.onStopWatching !== undefined && (detail()?.state ?? props.link.snapshot?.state ?? "open") === "open";
  const busy = () => actions.pending() !== null || handoff.handoff() !== null;
  const actionPending = () => {
    const current = action();
    if (current === "resolve") return handoff.handoff() === "conflicts";
    if (current === "fix") return handoff.handoff() === "findings";
    return actions.pending() !== null;
  };
  const runAction = () => {
    const current = detail();
    switch (action()) {
      case "resolve": void handoff.resolveConflicts(); break;
      case "fix": if (current) void handoff.fix(null, { reviewThreads: [], comments: [], checks: current.checks, commentsTruncated: false }); break;
      case "ready": void actions.perform("ready"); break;
      case "merge":
        void (props.confirmMerge ?? ((message: string) => confirm(message, { confirmLabel: "Merge" })))(`Merge ${term()}?\nThis merges #${props.link.number} using ${method()}.`).then((yes) => { if (yes && action() === "merge") void actions.perform("merge", method()); });
        break;
    }
  };
  const presentation = () => resolveState({ state: detail()?.state ?? props.link.snapshot?.state ?? "open", isDraft: detail()?.isDraft ?? props.link.snapshot?.isDraft ?? false });
  const open = () => openPullRequestSurface({ projectId: props.projectId, ...(props.link.host ? { host: props.link.host } : {}), repository: props.link.repository, number: props.link.number, url: props.link.url });
  const eyeHover = createHover();
  const checksOpen = signal(false);
  useOverlayOpen(checksOpen, "pull request checks");
  const rowClass = "min-h-8 w-full flex-row items-center gap-2.5 rounded-lg px-2.5 hover:bg-details-row-hover";
  const icon = () => <PRIcon name={presentation().icon} size={16} tint={toneColor(presentation().tone, colorScheme())} />;
  const eye = () => (watching() ? (
    <View
      class="size-6 items-center justify-center rounded-md hover:bg-details-row-hover"
      role="button"
      accessibilityLabel={`Stop watching #${props.link.number}`}
      tooltip="Watching: the agent wakes when checks finish, someone comments, or the branch conflicts. Click to stop."
      onPress={() => props.onStopWatching?.()}
      {...eyeHover.bind}
    >
      {eyeHover.hovered() ? <Icon name="eye-off" size={14} /> : <PRIcon name="eye" size={14} />}
    </View>
  ) : null);
  const rich = () => detail() !== null && (showChecks() || action() !== null || watching());
  return (
    <>
      {rich() ? (
        <View class="pb-1.5">
          <View role="button" accessibilityLabel={props.label} onPress={open} tooltip={<HoverCard detail={detail()!} breakdown={breakdown()} />} class={`${rowClass} items-start py-1.5`}>
            <View class="mt-0.5">{icon()}</View>
            <Text class="min-w-0 flex-1 text-[13px] font-medium leading-snug text-details-label line-clamp-2">{detail()!.title}</Text>
          </View>
          <View class="mt-1.5 h-5 min-w-0 flex-row items-center gap-0.5 pe-2.5 ps-9">
            <Text accessible={false} class="me-1 shrink-0 text-xs tabular-nums text-muted-foreground">{`#${props.link.number}`}</Text>
            {showChecks() ? (
              <Popover
                onOpenChange={trackOpenChange(checksOpen)}
                placement="bottom"
                align="start"
                popupClass="w-80 rounded-lg border border-border bg-popover p-3"
                trigger={
                  <View class="h-5 flex-row items-center gap-1 rounded-md px-1 hover:bg-details-row-hover" role="button" accessibilityLabel={`Checks ${describeChecks(detail()!.checks)}`}>
                    <PRIcon name={classifyChecks(detail()!.checks) === "failing" ? "circle-x" : classifyChecks(detail()!.checks) === "pending" ? "circle-dot" : "circle-check"} size={12} />
                    <Text class="text-xs tabular-nums text-muted-foreground">{checksCountLabel(detail()!.checks)}</Text>
                  </View>
                }
              >
                <ChecksList checks={() => detail()!.checks} />
              </Popover>
            ) : null}
            {eye()}
            <View class="flex-1" />
            {action() ? (
              <View
                class={`h-5 flex-row items-center gap-1 rounded-md px-1.5 hover:bg-details-row-hover ${busy() ? "opacity-50" : ""}`}
                role="button"
                accessibilityLabel={trailingActionCopy(action()!, term(), method()).label}
                tooltip={trailingActionCopy(action()!, term(), method()).tooltip}
                disabled={busy()}
                onPress={runAction}
              >
                <Text class={`text-xs font-medium ${trailingActionCopy(action()!, term(), method()).destructive ? "text-destructive" : "text-primary"}`}>
                  {actionPending() ? trailingActionCopy(action()!, term(), method()).pendingLabel : trailingActionCopy(action()!, term(), method()).label}
                </Text>
                {action() === "resolve" || action() === "fix" ? <HIcon name="arrow-up-right" size={12} /> : null}
              </View>
            ) : null}
          </View>
        </View>
      ) : (
        <View class="flex-row items-center">
          <View role="button" accessibilityLabel={props.label} onPress={open} tooltip={detail() ? <HoverCard detail={detail()!} breakdown={breakdown()} /> : props.label} class={`${rowClass} h-8 min-w-0 flex-1`}>
            {icon()}
            <Text class="min-w-0 flex-1 truncate text-[13px] font-medium text-details-label">{props.label}</Text>
          </View>
          {eye()}
        </View>
      )}
    </>
  );
}
