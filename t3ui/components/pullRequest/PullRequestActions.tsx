// The detail header's actions, ported from PullRequestDetailActions.tsx (the primary control)
// and PullRequestActionsMenu.tsx (everything else behind the overflow button), plus the comment
// and review forms (PullRequestCommentForm.tsx, PullRequestReviewForm.tsx) and the label picker.
import { effect, signal, Text, View } from "nsh";
import { PullRequestMarkdownTextarea } from "./PullRequestMarkdownTextarea";
import { Input } from "nsh/base";
import { createAnchor, Popup } from "../composer/Popover";
import { PRIcon } from "./PRIcon";
import { HIcon } from "../header/HeaderIcons";
import { PullRequestCandidatePicker } from "./PullRequestCandidatePicker";
import { ASK_MENU_TEXT, FIX_LABELS } from "./pullRequestHandoff.logic";
import {
  allowedMergeMethods, canPerform, canSubmitReview, detailActionable, MERGE_METHOD_LABELS, primaryControl, REVIEW_VERDICTS,
  type LabelCandidate, type MergeMethod, type ReviewVerdict,
} from "./pullRequestActions.logic";
import type { PullRequestActionsModel } from "./pullRequestActionsModel";
import type { PullRequestDetailData } from "./pullRequestDetail.logic";
import { pullRequestLabelColor } from "./pullRequestPresentation";
import { confirm } from "../toast";
import { openOnHostLabel } from "./pullRequestLinkContextMenu";

function PrimaryButton(props: { label: string; name: string; icon: string; disabled: boolean; onPress: () => void; /** aria-description: why it cannot be pressed yet. */ reason?: string }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.name}
      {...(props.reason ? { accessibilityHint: props.reason, tooltip: props.reason } : {})}
      onPress={() => { if (!props.disabled) props.onPress(); }}
      class={props.disabled ? "h-7 flex-row items-center gap-1.5 rounded-md bg-primary px-2.5 opacity-50 active:scale-[0.97] transition-transform duration-150 ease-in-out" : "h-7 flex-row items-center gap-1.5 rounded-md bg-primary px-2.5 active:scale-[0.97] transition-transform duration-150 ease-in-out"}
    >
      <PRIcon name={props.icon} size={14} />
      <Text class="text-xs font-medium text-primary-foreground">{props.label}</Text>
    </View>
  );
}

/** The header's one prominent control, which depends on where the pull request stands. */
/** `stack`: where the stack read stands (allowsSinglePullRequestMerge): on a host with stack actions a layer of a stack
 * merges through the stack menu, and merging alone waits until the read says there is no stack. */
export function PullRequestPrimaryAction(props: { detail: () => PullRequestDetailData; actions: PullRequestActionsModel; resolveConflicts?: { running: () => boolean; unavailable: () => boolean; onResolve: () => void }; stack?: { status: () => "idle" | "loading" | "loaded" | "error"; present: () => boolean } }) {
  const actions = props.actions;
  const stackActions = () => props.detail().capabilities.stacks && props.detail().capabilities.stackActions === true && props.stack !== undefined;
  const stackOwnsMerge = () => stackActions() && props.stack!.present();
  const mergeBlocked = (): string | null => {
    if (!stackActions() || stackOwnsMerge()) return null;
    const status = props.stack!.status();
    return status === "error" ? "Couldn't check stack membership" : status === "loaded" ? null : "Checking stack membership…";
  };
  const control = () => { const value = primaryControl(detailActionable(props.detail())); return stackOwnsMerge() && (value === "merge" || value === "enable-auto-merge") ? null : value; };
  const busy = () => actions.pending() !== null;
  const method = () => actions.mergeMethod();
  return (
    <>
      {control() === "ready" ? <PrimaryButton name="Ready for review" label="Ready for review" icon="git-pull-request-arrow" disabled={busy()} onPress={() => void actions.perform("ready")} /> : null}
      {control() === "merge" ? (
        <PrimaryButton
          name={actions.pending() === "merge" ? "Merging..." : actions.armed() === "merge" ? "Confirm merge?" : MERGE_METHOD_LABELS[method()]}
          label={actions.pending() === "merge" ? "Merging..." : actions.armed() === "merge" ? "Confirm merge?" : MERGE_METHOD_LABELS[method()]}
          icon={actions.armed() === "merge" ? "check" : "git-merge"}
          disabled={busy() || mergeBlocked() !== null}
          {...(mergeBlocked() ? { reason: mergeBlocked()! } : {})}
          onPress={() => { if (mergeBlocked() === null) actions.confirmThen("merge", () => void actions.perform("merge", method())); }}
        />
      ) : null}
      {control() === "enable-auto-merge" ? (
        <PrimaryButton
          name={actions.pending() === "enable-auto-merge" ? "Enabling..." : actions.armed() === "enable-auto-merge" ? "Confirm auto-merge?" : "Auto-merge"}
          label={actions.pending() === "enable-auto-merge" ? "Enabling..." : actions.armed() === "enable-auto-merge" ? "Confirm auto-merge?" : "Auto-merge"}
          icon={actions.armed() === "enable-auto-merge" ? "check" : "git-merge"}
          disabled={busy() || mergeBlocked() !== null}
          {...(mergeBlocked() ? { reason: mergeBlocked()! } : {})}
          onPress={() => { if (mergeBlocked() === null) actions.confirmThen("enable-auto-merge", () => void actions.perform("enable-auto-merge", method())); }}
        />
      ) : null}
      {control() === "auto-merge-armed" ? <View accessibilityLabel="Auto-merge on" class="h-6 flex-row items-center gap-1 rounded-md border border-border px-2"><PRIcon name="git-merge" size={14} /><Text class="text-xs text-foreground">Auto-merge on</Text></View> : null}
      {control() === "resolve" && !props.resolveConflicts ? <View accessibilityLabel="Has conflicts" class="h-6 flex-row items-center gap-1 rounded-md border border-destructive px-2"><PRIcon name="triangle-alert" size={14} /><Text class="text-xs text-destructive">Has conflicts</Text></View> : null}
      {control() === "resolve" && props.resolveConflicts ? (
        <View
          role="button"
          tooltip={props.resolveConflicts.running() ? "Preparing..." : "Resolve conflicts"}
          accessibilityLabel={props.resolveConflicts.running() ? "Preparing..." : "Resolve conflicts"}
          accessibilityState={{ disabled: props.resolveConflicts.running() || props.resolveConflicts.unavailable() }}
          onPress={() => { if (!props.resolveConflicts!.running() && !props.resolveConflicts!.unavailable()) props.resolveConflicts!.onResolve(); }}
          class={props.resolveConflicts.running() || props.resolveConflicts.unavailable() ? "h-6 flex-row items-center gap-1 rounded-md border border-destructive px-2 opacity-50" : "h-6 flex-row items-center gap-1 rounded-md border border-destructive px-2"}
        >
          <PRIcon name="triangle-alert" size={14} />
          <Text class="text-xs text-destructive">{props.resolveConflicts.running() ? "Preparing..." : "Resolve conflicts"}</Text>
        </View>
      ) : null}
    </>
  );
}

function MenuRow(props: { label: string; name?: string; icon?: string; checked?: boolean; disabled?: boolean; destructive?: boolean; onPress: () => void; /** A second, muted line under the label. */ detail?: string }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.name ?? props.label}
      onPress={() => { if (!props.disabled) props.onPress(); }}
      class={`${props.detail ? "min-h-7 items-start py-1" : "min-h-7 items-center py-1"} flex-row gap-2 rounded-sm px-2 ${props.disabled ? "opacity-50" : "hover:bg-accent-50"}`}
    >
      <View class={props.detail ? "mt-1 size-4 items-center justify-center" : "size-4 items-center justify-center"}>{props.checked ? <PRIcon name="check" size={14} /> : props.icon ? <PRIcon name={props.icon} size={14} /> : null}</View>
      <View class="min-w-0 flex-1 flex-col">
        <Text class={`text-sm ${props.destructive ? "text-destructive" : "text-foreground"}`}>{props.label}</Text>
        {props.detail ? <Text class="truncate text-xs text-muted-foreground">{props.detail}</Text> : null}
      </View>
    </View>
  );
}

const rule = () => <View class="mx-2 my-1 h-px bg-border" />;

/** Everything else the reader can do with the pull request, behind the header's overflow button. */
export function PullRequestActionsMenu(props: {
  detail: () => PullRequestDetailData;
  actions: PullRequestActionsModel;
  refreshing: () => boolean;
  onRefresh: () => void;
  onOpenHost: (url: string) => void;
  onCopy: (value: string) => void;
  /** Offered when threads can be linked: opens the thread picker. */
  onLinkToThread?: () => void;
  /** The menu item's copy (PullRequestThreadLinks menu-item): "Link to this thread" / "Unlink from this thread" beside a thread. */
  linkLabel?: () => string;
  /** "Write guide" / "Rewrite guide" (the review guide, offered where guides are enabled); absent hides it. */
  guide?: { running: () => boolean; written: () => boolean; onWrite: () => void };
  /** The environment is connected: deleting a branch needs it (`environmentConnected`). Defaults to connected. */
  connected?: () => boolean;
  /** Opens a thread on this pull request: "Ask a question" and "Explain this PR". `running` names the one in progress. */
  handoff?: { running: () => string | null; term: string; shortLabel: string; onAsk: () => void; onExplain: () => void; /** "Fix findings in a thread": absent hides it. */ onFixFindings?: () => void; /** pullRequestHandoffLabels for where the detail sits. */ labels?: () => { fixFindings: string } };
}) {
  const open = signal(false);
  const actions = props.actions;
  const detail = () => props.detail();
  const actionable = () => detailActionable(detail());
  const can = (name: Parameters<typeof canPerform>[1]) => canPerform(actionable(), name);
  const isOpen = () => detail().state === "open";
  const methods = () => allowedMergeMethods(actionable());
  const done = (run: () => void) => () => { open.set(false); run(); };
  const busy = () => actions.pending() !== null;
  const anchor = createAnchor();
  const term = () => props.handoff?.term ?? "pull request";
  const shortLabel = () => props.handoff?.shortLabel ?? "PR";
  const connected = () => props.connected?.() ?? true;
  const showsDeleteBranch = () => detail().state !== "open" && detail().capabilities.deleteBranch === true && can("delete-branch");
  const deleteBranch = async () => {
    const confirmed = await confirm(
      [`Delete branch ${detail().headBranch}?`, `This deletes ${detail().headBranch} from ${detail().headRepositoryNameWithOwner || detail().repository}. Local branches and worktrees are not changed.`].join("\n"),
      { variant: "destructive" },
    );
    if (confirmed) void actions.perform("delete-branch");
  };
  return (
    <View>
      <View
        ref={anchor.ref}
        role="button"
        accessibilityLabel={props.refreshing() ? `Refreshing ${term()}` : `More ${term()} actions`}
        onPress={() => open.update((value) => !value)}
        class="size-7 items-center justify-center rounded-md hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out"
      >
        <Text class="text-sm text-muted-foreground">⋯</Text>
      </View>
      {open() ? (
        <Popup anchor={anchor.anchor} onClose={() => open.set(false)} placement="bottom" align="end" class="min-w-60">
         <View class="flex-col p-1">
          {props.onLinkToThread ? <MenuRow label={props.linkLabel?.() ?? "Link to thread"} icon={props.linkLabel?.() === "Unlink from this thread" ? "unlink" : "link"} onPress={done(() => props.onLinkToThread!())} /> : null}
          <MenuRow label="Refresh" icon="refresh-cw" disabled={props.refreshing()} onPress={done(props.onRefresh)} />
          {props.handoff ? (
            <>
              <MenuRow label={props.handoff.running() === "ask" ? "Opening..." : "Ask a question"} name="Ask a question" detail={ASK_MENU_TEXT.ask(false, props.handoff.term)} icon="message-circle-question" disabled={props.handoff.running() !== null} onPress={done(props.handoff.onAsk)} />
              <MenuRow label={props.handoff.running() === "explain" ? "Opening..." : `Explain this ${props.handoff.shortLabel}`} name={`Explain this ${props.handoff.shortLabel}`} icon="book-open" detail={ASK_MENU_TEXT.explain} disabled={props.handoff.running() !== null} onPress={done(props.handoff.onExplain)} />
              {props.handoff.onFixFindings ? <MenuRow label={props.handoff.running() === "findings" ? "Preparing..." : (props.handoff.labels?.().fixFindings ?? FIX_LABELS.fixFindings)} name={props.handoff.labels?.().fixFindings ?? FIX_LABELS.fixFindings} icon="hammer" disabled={props.handoff.running() !== null} onPress={done(props.handoff.onFixFindings)} /> : null}
            </>
          ) : null}
          {props.guide ? <MenuRow label={props.guide.running() ? "Writing guide..." : !props.guide.written() ? "Write guide" : "Rewrite guide"} name={!props.guide.written() ? "Write guide" : "Rewrite guide"} icon="sparkles" disabled={props.guide.running()} onPress={done(props.guide.onWrite)} /> : null}
          {detail().canEditMaintainerEdits ? (
            <>
              {rule()}
              <MenuRow label="Allow edits from maintainers" checked={actions.maintainerEditsValue(detail(), `${detail().projectId}:${detail().number}`) === true} disabled={actions.maintainerSaving()}
                detail={actions.maintainerSaving() ? "Saving…" : "Maintainers can push to this branch. If your fork has workflows, this can also give access to its secrets."}
                onPress={() => void actions.setMaintainerEdits(actions.maintainerEditsValue(detail(), `${detail().projectId}:${detail().number}`) !== true, { key: `${detail().projectId}:${detail().number}`, observedAt: detail().observedAt })} />
            </>
          ) : null}
          {isOpen() ? rule() : null}
          {isOpen() && can(detail().isDraft ? "ready" : "draft") ? (
            <MenuRow label={detail().isDraft ? "Ready for review" : "Convert to draft"} name={detail().isDraft ? "Menu Ready for review" : "Convert to draft"} icon={detail().isDraft ? "git-pull-request-arrow" : "git-pull-request-draft"} disabled={busy()} onPress={done(() => void actions.perform(detail().isDraft ? "ready" : "draft"))} />
          ) : null}
          {isOpen() && !detail().isDraft && can("merge") && methods().length > 0 ? (
            <MenuRow label={actions.armed() === "menu-merge" ? "Confirm merge?" : "Merge now"} icon="git-merge" disabled={busy()} onPress={() => actions.confirmThen("menu-merge", done(() => void actions.perform("merge", actions.mergeMethod())))} />
          ) : null}
          {isOpen() && actionableAuto(detail()) === "disable" && can("disable-auto-merge") ? (
            <MenuRow label="Disable auto-merge" icon="git-merge" disabled={busy()} onPress={done(() => void actions.perform("disable-auto-merge"))} />
          ) : null}
          {isOpen() && actionableAuto(detail()) === "enable" && can("enable-auto-merge") && methods().length > 0 ? (
            <MenuRow label={actions.armed() === "menu-auto" ? "Confirm auto-merge?" : "Enable auto-merge"} icon="git-merge" disabled={busy()} onPress={() => actions.confirmThen("menu-auto", done(() => void actions.perform("enable-auto-merge", actions.mergeMethod())))} />
          ) : null}
          {isOpen() && methods().length > 1 ? rule() : null}
          {isOpen() && methods().length > 1 ? (
            <Each of={methods()} key={(method: MergeMethod) => method}>
              {(method) => <MenuRow label={MERGE_METHOD_LABELS[method()]} name={`Merge method ${method()}`} checked={actions.mergeMethod() === method()} onPress={() => actions.chosenMethod.set(method())} />}
            </Each>
          ) : null}
          {isOpen() && can("update-branch") ? <MenuRow label="Update branch" icon="refresh-cw" disabled={busy()} onPress={done(() => void actions.perform("update-branch"))} /> : null}
          {rule()}
          <MenuRow label={openOnHostLabel(detail().provider)} name="Menu Open on host" icon="external-link" onPress={done(() => props.onOpenHost(detail().url))} />
          <MenuRow label="Copy link" icon="link" onPress={done(() => props.onCopy(detail().url))} />
          <MenuRow label={`Copy ${shortLabel()} number`} icon="copy" onPress={done(() => props.onCopy(`#${detail().number}`))} />
          {isOpen() && can("close") ? <>{rule()}<MenuRow label={actions.armed() === "menu-close" ? "Confirm close?" : `Close ${term()}`} destructive icon="git-pull-request-closed" disabled={busy()} onPress={() => actions.confirmThen("menu-close", done(() => void actions.perform("close")))} /></> : null}
          {detail().state === "closed" && can("reopen") ? <>{rule()}<MenuRow label={`Reopen ${term()}`} icon="git-pull-request-arrow" disabled={busy()} onPress={done(() => void actions.perform("reopen"))} /></> : null}
          {detail().state === "merged" && can("revert") ? <>{rule()}<MenuRow label={actions.armed() === "menu-revert" ? "Confirm revert?" : "Revert changes"} name={actions.armed() === "menu-revert" ? "Confirm revert?" : "Revert changes"} destructive={actions.armed() === "menu-revert"} icon="rotate-ccw" disabled={busy()} onPress={() => actions.confirmThen("menu-revert", done(() => void actions.perform("revert")))} /></> : null}
          {showsDeleteBranch() ? <>{rule()}<MenuRow label={actions.pending() === "delete-branch" ? "Deleting branch..." : "Delete branch"} name="Delete branch" destructive icon="trash-2" detail={connected() ? detail().headBranch : "Reconnect to delete this branch"} disabled={busy() || !connected()} onPress={done(() => void deleteBranch())} /></> : null}
         </View>
        </Popup>
      ) : null}
    </View>
  );
}

function actionableAuto(detail: PullRequestDetailData): "enable" | "disable" | null {
  if (detail.autoMergeEnabled === true) return "disable";
  if (detail.autoMergeEnabled === false) return "enable";
  return null;
}

/** The comment form and, when the host offers verdicts, the review form (Leave a comment / Submit review). */
export function PullRequestComposer(props: { detail: () => PullRequestDetailData; actions: PullRequestActionsModel }) {
  const actions = props.actions;
  const mode = signal<"comment" | "review">("comment");
  let seenRequest = actions.reviewRequest();
  effect(() => { const request = actions.reviewRequest(); if (request !== seenRequest) { seenRequest = request; mode.set("review"); } });
  const text = signal("");
  const verdict = signal<ReviewVerdict>("comment");
  const verdicts = () => REVIEW_VERDICTS.filter((entry) => props.detail().permissions.verdicts.includes(entry.value) || (props.detail().permissions.verdicts.length === 0 && props.detail().capabilities.verdicts.includes(entry.value)));
  const canComment = () => props.detail().capabilities.comment && props.detail().permissions.comment;
  const busy = () => actions.pending() !== null;
  // reviewSummaryRequired("request-changes"): Forgejo wants a summary with Request changes, even beside line comments.
  const summaryRequired = () => props.detail().provider === "forgejo";
  const canSubmit = (summary: string) => canSubmitReview(verdict(), summary, actions.pendingReviewComments(), summaryRequired());

  // The review summary lives in the review store beside the pending line comments; the comment text is local.
  const value = () => (mode() === "review" ? actions.reviewSummary() : text());
  const setValue = (next: string) => { if (mode() === "review") actions.setReviewSummary(next); else text.set(next); };

  async function submit() {
    const ok = mode() === "comment" ? await actions.comment(text()) : await actions.submitReview(verdict(), actions.reviewSummary(), summaryRequired());
    if (ok && mode() === "comment") text.set("");
  }
  // PullRequestCommentForm's followUpAction: Close with comment on an open one, Reopen with comment on a closed one,
  // when the host offers the action and the viewer may take it.
  const followUp = (): "close" | "reopen" | null => {
    const detail = props.detail();
    if (detail.state === "open" && detail.capabilities.actions.includes("close") && detail.permissions.actions.includes("close")) return "close";
    if (detail.state === "closed" && detail.capabilities.actions.includes("reopen") && detail.permissions.actions.includes("reopen")) return "reopen";
    return null;
  };
  async function submitFollowUp(action: "close" | "reopen") {
    const body = text().trim();
    if (body.length === 0 || busy()) return;
    const result = await actions.commentAction(body, action);
    if (result.commentPosted) text.set("");
  }
  const followUpLabel = (action: "close" | "reopen") => action === "close"
    ? (actions.pending() === "close" ? "Closing..." : actions.armed() === "close-with-comment" ? "Confirm close?" : "Close with comment")
    : (actions.pending() === "reopen" ? "Reopening..." : "Reopen with comment");

  const reviewPlaceholder = () => canSubmit("")
    ? "Summarize your review (optional)"
    : verdict() === "request-changes" && summaryRequired()
      ? "Summarize your review (required to request changes)"
      : "Summarize your review or add line comments";

  return canComment() || verdicts().length > 0 ? (
    <View class="flex-col gap-2 border-t border-border-60 px-4 py-3" accessibilityLabel="Add a comment">
      {verdicts().length > 0 ? (
        <View class="flex-row items-center gap-0.5" role="group" accessibilityLabel="Composer mode">
          <View accessibilityLabel="Comment tab" role="button" onPress={() => mode.set("comment")} class={mode() === "comment" ? "rounded-md bg-accent px-2.5 py-1" : "rounded-md px-2.5 py-1 hover:bg-accent-50"}><Text class={mode() === "comment" ? "text-xs font-medium text-foreground" : "text-xs text-muted-foreground"}>Comment</Text></View>
          <View accessibilityLabel="Review tab" role="button" onPress={() => mode.set("review")} class={mode() === "review" ? "rounded-md bg-accent px-2.5 py-1" : "rounded-md px-2.5 py-1 hover:bg-accent-50"}><Text class={mode() === "review" ? "text-xs font-medium text-foreground" : "text-xs text-muted-foreground"}>{actions.pendingReviewComments() > 0 ? `Review (${actions.pendingReviewComments()})` : "Review"}</Text></View>
          <View class="flex-1" />
          {mode() === "review" && actions.pendingReviewComments() > 0 ? (
            <View role="button" accessibilityLabel="Discard pending line comments" tooltip="Discard pending line comments" onPress={() => { if (!busy()) actions.discardPendingReviewComments(); }} class={`size-6 items-center justify-center rounded-md ${busy() ? "opacity-50" : "hover:bg-accent-50"}`}><HIcon name="trash-2" size={14} /></View>
          ) : null}
        </View>
      ) : null}
      <PullRequestMarkdownTextarea
        label={mode() === "comment" ? "Comment on this pull request" : "Review summary"}
        placeholder={mode() === "comment" ? "Leave a comment" : reviewPlaceholder()}
        value={value()}
        rows={4}
        completion={actions.completion()}
        onValueChange={setValue}
        onModEnter={() => { if (!busy() && (mode() === "comment" ? text().trim().length > 0 : canSubmit(actions.reviewSummary()))) void submit(); }}
      />
      <View class="flex-row flex-wrap items-center justify-end gap-2">
        {actions.error() ? <Text class="mr-auto min-w-0 shrink text-xs text-destructive">{actions.error()}</Text> : null}
        {actions.notice() ? <Text class="mr-auto text-xs text-muted-foreground">{actions.notice()}</Text> : null}
        {mode() === "review" ? (
          <View class="flex-row items-center gap-0.5 rounded-lg bg-segmented-track p-0.5" accessibilityLabel="Review verdict">
            <Each of={verdicts()} key={(entry: { value: ReviewVerdict; label: string }) => entry.value}>
              {(entry) => (
                <View accessibilityLabel={entry().label} role="button" onPress={() => verdict.set(entry().value)} class={verdict() === entry().value ? "rounded-md bg-segmented-active px-2 py-1 transition-colors duration-150 ease-in-out" : "rounded-md px-2 py-1 hover:bg-segmented-hover transition-colors duration-150 ease-in-out"}>
                  <Text class={verdict() === entry().value ? "text-xs font-medium text-foreground" : "text-xs text-muted-foreground"}>{entry().label}</Text>
                </View>
              )}
            </Each>
          </View>
        ) : null}
        {mode() === "comment" && followUp() !== null ? (
          <View
            role="button"
            accessibilityLabel={followUpLabel(followUp()!)}
            onPress={() => {
              const action = followUp();
              if (!action || text().trim().length === 0 || busy()) return;
              if (action === "close") actions.confirmThen("close-with-comment", () => void submitFollowUp("close"));
              else void submitFollowUp("reopen");
            }}
            class={`h-7 flex-row items-center gap-1 rounded-md border px-2.5 ${followUp() === "close" ? "border-destructive" : "border-border"} ${text().trim().length === 0 || busy() ? "opacity-50" : "hover:bg-accent-50"}`}
          >
            <PRIcon name={followUp() === "close" ? "git-pull-request-closed" : "git-pull-request-arrow"} size={14} />
            <Text class={`text-xs ${followUp() === "close" ? "text-destructive-foreground" : "text-foreground"}`}>{followUpLabel(followUp()!)}</Text>
          </View>
        ) : null}
        <View
          role="button"
          accessibilityLabel={mode() === "comment" ? "Post comment" : "Submit review"}
          onPress={() => { if (!busy()) void submit(); }}
          class={(mode() === "comment" ? text().trim().length === 0 : !canSubmit(actions.reviewSummary())) || busy() ? "h-7 flex-row items-center rounded-md border border-border px-2.5 opacity-50" : "h-7 flex-row items-center rounded-md border border-border px-2.5 hover:bg-accent-50"}
        >
          <Text class="text-xs text-foreground">{actions.pending() === "comment" ? "Posting..." : actions.pending() === "review" ? "Submitting..." : mode() === "comment" ? "Comment" : "Submit review"}</Text>
        </View>
      </View>
    </View>
  ) : null;
}

/** The Labels row's picker: every label the repository offers, ticked when applied. */
/** PullRequestLabelPicker on PullRequestCandidatePicker: shown when the host has labels; without triage access the
 * button is there but dimmed with its reason. Each press puts one label on or takes it off. */
export function PullRequestLabelPicker(props: { detail: () => PullRequestDetailData; actions: PullRequestActionsModel }) {
  const actions = props.actions;
  if (props.detail().capabilities.labels !== true) return null;
  const query = signal("");
  const shown = () => {
    const needle = query().toLowerCase();
    return actions.candidates().filter((entry) => needle.length === 0 || entry.name.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle));
  };
  return (
    <PullRequestCandidatePicker<LabelCandidate>
      icon="tag"
      label="Change labels"
      allowed={props.detail().permissions.labels !== false}
      disabledReason="Changing labels needs triage access on this repository"
      open={actions.labelsOpen}
      onToggle={() => actions.toggleLabelsMenu()}
      query={query}
      onQueryChange={(next) => query.set(next)}
      searchLabel="Search labels"
      isPending={() => actions.labelsStatus() === "loading"}
      error={() => (actions.labelsStatus() === "error" ? actions.labelsError() : null)}
      candidates={shown}
      emptyLabel="This repository has no labels."
      noMatchLabel="No label matches that."
      errorLabel="The labels could not be read."
      truncatedLabel={() => (actions.labelsTruncated() ? "This repository has more labels than are listed here. Apply the rest on the host." : null)}
      candidateKey={(candidate) => `Label ${candidate.name}`}
      disabled={() => actions.labelPending() !== null}
      onSelect={(candidate) => void actions.toggleLabel(candidate.name)}
      row={(candidate) => (
        <>
          <View class="size-2 shrink-0 rounded-full bg-muted-foreground" style={pullRequestLabelColor(candidate.color) ? { backgroundColor: pullRequestLabelColor(candidate.color)! } : undefined} />
          <Text class="min-w-0 flex-1 truncate text-sm text-foreground">{candidate.description ? `${candidate.name} · ${candidate.description}` : candidate.name}</Text>
          {candidate.isApplied ? <View accessibilityLabel="Applied"><PRIcon name="check" size={14} /></View> : null}
        </>
      )}
    />
  );
}


/** The Summary tab's right end when the host holds workflow runs for approval (PullRequestApproveWorkflowsButton). */
export function PullRequestApproveWorkflowsButton(props: { actions: PullRequestActionsModel }) {
  const actions = props.actions;
  const label = () => actions.pending() === "approve-workflows" ? "Approving..." : actions.armed() === "approve-workflows" ? "Confirm approve?" : "Approve workflows to run";
  return (
    <View role="button" accessibilityLabel={label()} tooltip={label()} onPress={() => { if (actions.pending() === null) actions.confirmThen("approve-workflows", () => void actions.perform("approve-workflows")); }}
      class={actions.pending() !== null ? "ml-auto h-6 shrink-0 flex-row items-center gap-1.5 rounded-md border border-warning px-2 opacity-50" : "ml-auto h-6 shrink-0 flex-row items-center gap-1.5 rounded-md border border-warning px-2 hover:bg-warning-surface"}>
      <PRIcon name="play" size={14} />
      <Text class="text-xs text-foreground">{label()}</Text>
    </View>
  );
}
