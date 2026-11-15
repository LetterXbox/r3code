// The detail panel, ported from PullRequestDetailPanel.tsx: the crumbs and actions row, the header body
// (title, author, branches, diff stat), the tab bar and the active tab (Summary, Guide, Timeline, Code).
import { Clipboard, effect, openUrl, Scroll, signal, Text, View } from "nsh";
import { pullRequestChecksStale, pullRequestStackNotice, resolvedDetailChecksState } from "./pullRequestDetail.logic";
import { createAnchor } from "../composer/Popover";
import { PullRequestLinkedThreads, PullRequestThreadPicker } from "./PullRequestThreadLinks";
import { backendStatus, settingValue } from "../../store";
import type { PullRequestEntry } from "../../pages/utility-data";
import { serverSettings } from "../../pages/settings/settingsState";
import { showToast } from "../toast";
import { PullRequestChangeBreakdownStat } from "./PullRequestChangeBreakdownStat";
import { PRIcon } from "./PRIcon";
import type { PullRequestFinding } from "./pullRequestHandoff.logic";
import { PullRequestActionsMenu, PullRequestApproveWorkflowsButton, PullRequestPrimaryAction } from "./PullRequestActions";
import { canPerform, detailActionable } from "./pullRequestActions.logic";
import { PullRequestActorLabel } from "./PullRequestActorLabel";
import { PullRequestBaseBranch } from "./PullRequestBaseBranch";
import { PullRequestChecksStatusLine, PullRequestDetailHeaderBody, PullRequestDetailTabBar } from "./PullRequestDetailLayout";
import { PullRequestDetailChecks } from "./PullRequestDetailChecks";
import { PullRequestDetailCrumbs } from "./PullRequestDetailCrumbs";
import { PullRequestCheckoutMenu } from "./PullRequestCheckoutMenu";
import type { PullRequestHandoffModel } from "./pullRequestHandoffModel";
import { PullRequestCodeTab } from "./PullRequestCodeTab";
import { PullRequestCopyableCode } from "./PullRequestCopyableCode";
import { PullRequestDetailGhost } from "./PullRequestGhosts";
import { PullRequestGuideTab } from "./PullRequestGuideTab";
import { PullRequestStackMenu } from "./PullRequestStackMenu";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import { PullRequestSummaryTab } from "./PullRequestSummaryTab";
import { PullRequestTimelineTab } from "./PullRequestTimelineTab";
import { PullRequestTitleEditor } from "./PullRequestTitleEditor";
import { describeChecks } from "./pullRequestActions.logic";
import type { PullRequestCheckoutModel } from "./pullRequestCheckoutModel";
import { changeRequestTerm, pullRequestCheckoutCommand, repositoryUrlOf } from "./pullRequestCheckout.logic";
import { approvalCount } from "./pullRequestConversation.logic";
import { resolveBaseFreshness, type PullRequestDetailData, type StackLayer } from "./pullRequestDetail.logic";
import type { DetailTab, PullRequestDetailModel } from "./pullRequestDetailModel";
import { guidesEnabled, guideRunning } from "./pullRequestGuide.logic";
import { formatCount, relativeTime, resolveChecksState, resolveState, toneColor, type Scheme } from "./pullRequestPresentation";
import { openOnHostLabel } from "./pullRequestLinkContextMenu";
import { openPaletteOnLinkedThreads } from "../palette/paletteModel";
import { environmentId as serverEnvironmentId } from "../sidebar/serverFacts";
import { diffAdditionClass, diffDeletionClass } from "../diff/diffColorScheme";
import { useLiveRefresh } from "../coordinators/liveRefresh";

const TABS: { value: DetailTab; label: string }[] = [
  { value: "summary", label: "Summary" },
  { value: "guide", label: "Guide" },
  { value: "timeline", label: "Timeline" },
  { value: "code", label: "Code" },
];

const HOST_LABEL: Record<string, string> = { github: "GitHub", gitlab: "GitLab", bitbucket: "Bitbucket", "azure-devops": "Azure DevOps", forgejo: "Forgejo", gitcafe: "GitCafe", "cursor-origin": "Cursor Origin" };

function scheme(): Scheme {
  return settingValue("colorScheme") === "light" ? "light" : "dark";
}

export function PullRequestDetailPanel(props: {
  entry: () => PullRequestEntry | null;
  model: PullRequestDetailModel;
  now: () => number;
  onClose: () => void;
  /** The enclosing panel supplies its own close control in the tab strip. */
  closeInTabStrip?: boolean;
  onOpenHost: (url: string) => void;
  /** The thread the detail sits beside: the link item links or unlinks it directly (currentThreadRef). */
  currentThreadId?: () => string | null;
  onOpenNumber?: (layer: StackLayer) => void;
  checkout?: PullRequestCheckoutModel;
  /** Ask / Explain / Resolve conflicts, which open a thread on the pull request. */
  handoff?: PullRequestHandoffModel;
  /** The app's threads, for the linked-threads list and the picker. */
  threads?: { all: () => { id: string; title: string; projectId: string; updatedAt: number }[]; projectName: (projectId: string) => string; open: (threadId: string) => void };
}) {
  const pickerOpen = signal(false);
  const headerAnchor = createAnchor();
  const model = props.model;
  // The menu says "Rewrite guide" once a guide exists, so it is read as soon as the pull request is, not when the tab opens.
  effect(() => { if (props.entry() && guidesEnabled(serverSettings())) model.guide.ensureLoaded(); });
  const detail = () => model.detail();
  // PullRequestThreadLinks display="menu-item": beside a thread it links or unlinks that thread, else opens the picker.
  const linkedHere = () => { const current = props.currentThreadId?.(); return current ? (model.threadLinks.linked() ?? []).some((thread) => thread.id === current) : false; };
  const linkMenuLabel = () => (linkedHere() ? "Unlink from this thread" : props.currentThreadId?.() ? "Link to this thread" : "Link to thread");
  const linkToThread = () => { const current = props.currentThreadId?.(); if (current) void model.threadLinks.changeLink(current, linkedHere()); else pickerOpen.set(true); };
  // openCheck (PullRequestSummaryTab): a check's Details link; a failure is "Unable to open check details".
  const openCheck = (url: string) => {
    void openUrl(url).then((result) => { if (!result.opened) showToast({ type: "error", title: "Unable to open check details" }); })
      .catch(() => showToast({ type: "error", title: "Unable to open check details" }));
  };
  const entry = () => props.entry();
  // PullRequestDetailPanel.tsx:595 useLiveRefresh, keyed by the pull request (added by the shell-stores fix; minimal hook only).
  useLiveRefresh(() => { if (props.entry()) void model.refresh(); }, { key: `pull-request:${props.entry()?.projectId ?? ""}:${props.entry()?.repository ?? ""}#${props.entry()?.number ?? ""}` });
  const provider = () => detail()?.provider ?? entry()?.provider ?? "github";
  const term = () => changeRequestTerm(provider());
  const state = () => (detail() ? resolveState(detail()!) : null);
  const stateTone = () => (state() ? toneColor(state()!.tone, scheme()) : null);
  const repositoryUrl = () => (detail() ? repositoryUrlOf(detail()!.url) : null);
  const freshness = () => (detail() ? resolveBaseFreshness(detail()!) : null);
  const checkoutCommand = () => {
    const d = detail();
    return d ? pullRequestCheckoutCommand({ provider: d.provider, number: d.number, headBranch: d.headBranch, headRepositoryNameWithOwner: d.headRepositoryNameWithOwner, repositoryUrl: repositoryUrlOf(d.url) }) : null;
  };
  const visibleTabs = () => TABS.filter((item) => (item.value !== "guide" || guidesEnabled(serverSettings())) && (item.value !== "code" || detail()!.capabilities.diff));
  const checksPresentation = () => resolveChecksState(resolvedDetailChecksState(props.entry()?.checksState, detail()?.checks ?? []) ?? "");
  const checksSummary = () => detail() ? (pullRequestChecksStale(props.entry()?.checksState, detail()!.checks) ? checksPresentation()?.label ?? "No checks reported" : describeChecks(detail()!.checks)) : "";
  const stackable = () => detail()?.capabilities.stacks === true;

  // Decided in the JSX below, not here: the panel stays mounted while one pull request gives way to another.
  const loadingGhost = () => model.status() === "loading" && !detail();

  return (
    <View class={props.closeInTabStrip ? "min-w-0 flex-1 flex-col bg-background" : "min-w-0 flex-1 flex-col border-l border-border bg-background"} accessibilityLabel="Pull request detail">
      {pickerOpen() && props.threads ? <PullRequestThreadPicker links={model.threadLinks} threads={props.threads.all} projectName={props.threads.projectName} linkedIds={() => new Set((model.threadLinks.linked() ?? []).map((thread) => thread.id))} anchor={headerAnchor.anchor} onClose={() => pickerOpen.set(false)} /> : null}
      {loadingGhost() ? <PullRequestDetailGhost seed={entry() ? { ...entry()!, author: entry()!.author ? { login: entry()!.author } : null } : null} now={props.now} scheme={scheme} {...(props.closeInTabStrip ? {} : { onClose: props.onClose })} onOpen={props.onOpenHost} /> : null}
      {!loadingGhost() ? <View class="min-h-0 flex-1 flex-col">
      <View class={detail() ? "shrink-0 flex-col border-b border-border-60" : "shrink-0 flex-col"}>
        <View class="flex-row items-start gap-x-2">
          <PullRequestDetailCrumbs
            detail={detail() ? { url: detail()!.url, provider: provider(), number: detail()!.number, repository: detail()!.repository } : entry() ? { url: entry()!.url, provider: entry()!.provider, number: entry()!.number, repository: entry()!.repository } : null}
            tone={stateTone()}
            repositoryUrl={repositoryUrl()}
            onOpen={props.onOpenHost}
          />
          <View ref={headerAnchor.ref} class="mr-4 h-7 shrink-0 flex-row items-center justify-end gap-1">
            {detail() && props.threads ? <PullRequestLinkedThreads links={model.threadLinks} projectName={props.threads.projectName} onOpenThread={props.threads.open} onOpenInPalette={(threads) => openPaletteOnLinkedThreads({ query: detail()!.url, environmentId: serverEnvironmentId() ?? "", threads })} /> : null}
            {detail() && model.stack() && model.stack()!.layers.length > 1 ? (
              <PullRequestStackMenu
                stack={model.stack()!}
                currentNumber={detail()!.number}
                hostLabel={HOST_LABEL[provider()] ?? "The host"}
                term={{ singular: term(), plural: `${term()}s` }}
                actions={model.actions}
                scheme={scheme}
                canMerge={() => stackable() && detail()!.permissions.actions.includes("merge") && model.actions.mergeMethod() !== undefined && (detail()!.capabilities.mergeMethods.length > 0)}
                canRebase={() => stackable() && detail()!.stackRebase}
                onSelect={(layer) => props.onOpenNumber?.(layer)}
                notice={() => pullRequestStackNotice(model.stack() !== null, model.stackStatus())}
                stale={() => model.stackStatus() === "error"}
                onRetry={() => void model.refresh()}
              />
            ) : null}
            {detail() ? <PullRequestPrimaryAction detail={() => detail()!} actions={model.actions} stack={{ status: () => model.stackStatus(), present: () => model.stack() !== null }} {...(props.handoff && props.checkout ? { resolveConflicts: { running: () => props.handoff!.handoff() === "conflicts", unavailable: () => props.checkout!.root() === null, onResolve: () => void props.handoff!.resolveConflicts() } } : {})} /> : null}
            {detail() && props.checkout ? <PullRequestCheckoutMenu term={term()} checkout={props.checkout} canCheckout={() => detail()!.state === "open"} /> : null}
            {detail() ? <PullRequestActionsMenu detail={() => detail()!} actions={model.actions} refreshing={() => model.status() === "loading" || model.refreshing()} onRefresh={() => void model.refreshFromHost()} onOpenHost={props.onOpenHost} onCopy={(value) => void Clipboard.writeText(value).catch(() => undefined)} {...((props.threads || props.currentThreadId?.()) && model.threadLinks.supported() ? { onLinkToThread: linkToThread, linkLabel: linkMenuLabel } : {})} {...(guidesEnabled(serverSettings()) ? { guide: { running: () => model.guide.writing() || (model.guide.result() !== null && guideRunning(model.guide.result()!)), written: () => model.guide.result()?.guide != null, onWrite: () => { const written = model.guide.result()?.guide != null; void model.guide.write(); if (!written) model.tab.set("guide"); } } } : {})} connected={() => backendStatus() === "connected"} {...(props.handoff ? { handoff: { running: () => props.handoff!.handoff(), term: term(), shortLabel: provider() === "gitlab" ? "MR" : "PR", onAsk: () => props.handoff!.ask(), onExplain: () => props.handoff!.explain(), labels: () => props.handoff!.labels(), onFixFindings: () => void props.handoff!.fix(null, { reviewThreads: model.activity()?.reviewThreads ?? [], comments: model.activity()?.comments ?? [], checks: detail()!.checks, commentsTruncated: false, hostLabel: HOST_LABEL[provider()] ?? "the host" }) } } : {})} /> : null}
            {!props.closeInTabStrip ? <View accessibilityLabel={`Collapse ${term()} panel`} role="button" onPress={props.onClose} class="size-6 items-center justify-center rounded-md hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out"><PRIcon name="panel-right" size={14} /></View> : null}
          </View>
        </View>

        {detail() ? (
          <PullRequestDetailHeaderBody
            title={<PullRequestTitleEditor detail={() => detail()!} actions={model.actions} />}
            author={<PullRequestActorLabel actor={detail()!.author} />}
            updated={<Text class="text-xs text-muted-foreground">{`updated ${relativeTime(detail()!.updatedAt, props.now())}`}</Text>}
            checkout={checkoutCommand() ? <PullRequestCopyableCode value={checkoutCommand()!} copyLabel="Copy checkout command" copiedLabel="Checkout command copied" class="ml-auto" onError={(description) => showToast({ type: "error", title: "Could not copy checkout command", description })} /> : null}
            base={<PullRequestBaseBranch baseBranch={detail()!.baseBranch} freshness={freshness()} stacked={(model.stack()?.layers.length ?? 0) > 1} pending={() => model.actions.pending() !== null} onUpdate={(method) => void model.actions.updateBranch(method)} />}
            head={<PullRequestCopyableCode value={detail()!.headBranch} copyLabel={`Copy ${term()} branch`} copiedLabel="Branch name copied" class="min-w-0" />}
            files={`${detail()!.changedFiles.toLocaleString("en-US")} ${detail()!.changedFiles === 1 ? "file" : "files"}`}
            diffStat={<PullRequestChangeBreakdownStat eager reference={{ projectId: detail()!.projectId, ...(props.entry()?.host ? { host: props.entry()!.host } : {}), repository: detail()!.repository, number: detail()!.number }} additions={detail()!.additions} deletions={detail()!.deletions} request={model.request} />}
          />
        ) : null}

        {detail() ? (
          <PullRequestDetailTabBar tabs={visibleTabs()} value={model.tab()} onValueChange={(tab) => model.tab.set(tab)}>
            {model.tab() === "summary" ? (detail()!.state === "open" && detail()!.workflowApprovalsRequired > 0 && !pullRequestChecksStale(props.entry()?.checksState, detail()!.checks) && canPerform(detailActionable(detail()!), "approve-workflows") ? (
              <PullRequestApproveWorkflowsButton actions={model.actions} />
            ) : (
              checksPresentation() ? <PullRequestDetailChecks icon={checksPresentation()!.icon} label={checksPresentation()!.label} summary={checksSummary()} tint={toneColor(checksPresentation()!.tone, scheme())} checks={() => detail()?.checks ?? []} stale={() => pullRequestChecksStale(props.entry()?.checksState, detail()?.checks ?? [])} scheme={scheme} onOpenCheck={openCheck} /> : <PullRequestChecksStatusLine
                accessibilityLabel={checksSummary() ? `Checks: ${checksSummary()}` : "Checks"}
                icon={<PRIcon name={checksPresentation()?.icon ?? "circle-dot"} size={14} tint={checksPresentation() ? toneColor(checksPresentation()!.tone, scheme()) : undefined} />}
                label={checksSummary()}
              />
            )) : model.tab() === "timeline" ? (
              <View class="ml-auto shrink-0 flex-row items-center gap-2">
                <View class="flex-row items-center gap-1.5">
                  <View class="flex-row items-center gap-1" accessibilityLabel={model.activityError() ? "Comments unavailable" : `${detail()!.changedFiles === 0 && false ? 0 : (model.activity()?.commentCount ?? 0)} comments`}>
                    <PRIcon name="message-square" size={12} />
                    <Text class="text-2xs text-muted-foreground">{model.activityError() ? "-" : !model.activity() ? "…" : String(model.activity()!.commentCount)}</Text>
                  </View>
                  <Text class="text-xs text-muted-foreground">·</Text>
                  <View class="flex-row items-center gap-1" accessibilityLabel={model.activityError() ? "Commits unavailable" : `${model.activity()?.commits.length ?? 0} commits`}>
                    <PRIcon name="git-commit-horizontal" size={12} />
                    <Text class="text-2xs text-muted-foreground">{model.activityError() ? "-" : !model.activity() ? "…" : String(model.activity()!.commits.length)}</Text>
                  </View>
                  {approvalCount(model.activity()) > 0 ? (
                    <>
                      <Text class="text-xs text-muted-foreground">·</Text>
                      <View class="flex-row items-center gap-1" accessibilityLabel={`${approvalCount(model.activity())} ${approvalCount(model.activity()) === 1 ? "approval" : "approvals"}`}>
                        <PRIcon name="circle-check" size={12} tint={toneColor({ light: "#059669", dark: "#6ee7b7" }, scheme())} />
                        <Text class="text-2xs" style={{ color: toneColor({ light: "#059669", dark: "#6ee7b7" }, scheme()) }}>{String(approvalCount(model.activity()))}</Text>
                      </View>
                    </>
                  ) : null}
                </View>
                <View role="button" accessibilityLabel={model.timelineOrder() === "newest" ? "Show oldest activity first" : "Show newest activity first"} onPress={() => model.timelineOrder.set(model.timelineOrder() === "newest" ? "oldest" : "newest")} class="h-6 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent-50">
                  <PRIcon name="arrow-up-down" size={12} />
                  <Text class="text-xs text-muted-foreground">{model.timelineOrder() === "newest" ? "Newest first" : "Oldest first"}</Text>
                </View>
              </View>
            ) : null}
          </PullRequestDetailTabBar>
        ) : null}
      </View>

      {model.status() === "error" ? (
        <PullRequestsUnavailableState
          {...(model.notFound()
            ? { title: `${term().charAt(0).toUpperCase()}${term().slice(1)} #${entry()?.number ?? ""} not found`, error: `It may be an issue rather than a ${term()}, or this account can't see it.` }
            : { error: model.error() })}
          onRetry={() => void model.reload()}
        />
      ) : null}

      {detail() ? (
        <View class="min-h-0 flex-1 flex-col">
          {model.tab() === "code" ? <PullRequestCodeTab code={model.code} review={model.review} actions={model.actions} now={props.now} provider={entry()?.provider ?? "github"} url={detail()!.url} number={detail()!.number} commits={() => model.activity()?.commits ?? []} onOpenHost={props.onOpenHost} {...(props.handoff ? { fixLabel: () => props.handoff!.labels().fixFinding, onFixFinding: (finding: PullRequestFinding) => void props.handoff!.fix(finding), onAddToAgent: (selection: Parameters<NonNullable<typeof props.handoff>["addSelection"]>[0], request: string) => props.handoff!.addSelection(selection, request) } : {})} /> : null}
          {model.tab() === "guide" ? <PullRequestGuideTab guide={model.guide} detail={() => detail()!} actions={model.actions} ref={() => (props.entry() ? { projectId: props.entry()!.projectId, ...(props.entry()!.host ? { host: props.entry()!.host } : {}), repository: props.entry()!.repository, number: props.entry()!.number } : null)} onOpenFile={(path) => { model.code.requestReveal(path); model.tab.set("code"); }}
            {...(props.handoff ? { onAskAboutLines: (selection: Parameters<NonNullable<typeof props.handoff>["addSelection"]>[0], request: string) => props.handoff!.addSelection(selection, request), onAskAboutStop: (stop: { title: string; summary: string; attention: { note: string } | null; excerpts: { path: string; side: string; start: number; end: number }[] }, index: number, question: string) => props.handoff!.askAboutStop({ index, title: stop.title, summary: stop.summary, attention: stop.attention?.note ?? null, excerpts: stop.excerpts }, question) } : {})}
            {...(detail()!.capabilities.verdicts.some((verdict) => detail()!.permissions.verdicts.includes(verdict)) ? { onFinishReview: () => { model.actions.requestReview(); model.tab.set("timeline"); } } : {})} /> : null}
          {model.tab() === "summary" ? <PullRequestSummaryTab detail={() => detail()!} model={model} now={props.now} onOpenLink={props.onOpenHost} onOpenCheck={openCheck} checksStale={() => pullRequestChecksStale(props.entry()?.checksState, detail()!.checks)} onRefreshChecks={() => void model.refreshFromHost()} {...(props.handoff ? { fixCheckLabel: () => props.handoff!.labels().fixCheck, fixFindingLabel: () => props.handoff!.labels().fixFinding, onFixFinding: (finding: PullRequestFinding) => void props.handoff!.fix(finding), pendingFinding: () => props.handoff!.handoff() } : {})} /> : null}
          {model.tab() === "timeline" ? <PullRequestTimelineTab detail={() => detail()!} model={model} now={props.now} onOpenHost={props.onOpenHost} onOpenCommit={(oid) => { model.code.selectedCommit.set(oid); model.tab.set("code"); }} /> : null}
        </View>
      ) : null}
      </View> : null}
    </View>
  );
}

