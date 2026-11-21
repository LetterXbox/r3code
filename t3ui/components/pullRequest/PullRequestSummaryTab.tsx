// The Summary tab, ported from PullRequestSummaryTab.tsx: the Reviewers and Labels rows, then the collapsible
// Description, Checks and Comments sections.
import { cleanup, colorScheme, effect, Scroll, signal, Storage, Text, token, View } from "nsh";
import { createHover } from "../hoverReveal";
import { createAnchor, Popup } from "../composer/Popover";
import { tokenAlpha } from "../composer/tokenColor";
import { mixColors } from "../sidebar/mix";
import { settingValue } from "../../store";
import { PRIcon } from "./PRIcon";
import { PullRequestActorAvatar, PullRequestActorLabel } from "./PullRequestActorLabel";
import { PullRequestActivityUnavailableState } from "./PullRequestActivityUnavailableState";
import { PullRequestCommentBody } from "./PullRequestCommentBody";
import { PullRequestEditButton } from "./PullRequestEditButton";
import { PullRequestConversationGhost } from "./PullRequestGhosts";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { findingKey, FIX_LABELS, type PullRequestFinding } from "./pullRequestHandoff.logic";
import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";
import { PullRequestReactionBar } from "./PullRequestReactions";
import { PullRequestReviewerPicker } from "./PullRequestReviewerPicker";
import { PullRequestLabelPicker } from "./PullRequestActions";
import { ReviewThreadCard } from "./PullRequestReviewAnnotation";
import { changeRequestTerm } from "./pullRequestCheckout.logic";
import {
  conversationCommentCount, conversationItems, DEFAULT_COMMENT_FILTER, filterConversation, pageConversations, REVIEW_OUTCOME_LABEL, reviewerEntries, reviewOutcome, reviewOutcomeStaleLabel, totalConversationComments,
  type CommentFilter, type ConversationItem, type ReviewerEntry,
} from "./pullRequestConversation.logic";
import { CHECK_STATUS, type DetailComment, type DetailLabel, type PullRequestDetailData, checkStatusLabel } from "./pullRequestDetail.logic";
import type { PullRequestDetailModel } from "./pullRequestDetailModel";
import { canEditPullRequestComment, visibleBody, type ReviewReaction } from "./pullRequestReview.logic";
import { pullRequestLabelColor, relativeTime, toneColor, type Scheme } from "./pullRequestPresentation";
import { toggleWithLayout } from "../motion/Motion";
import { COLLAPSE_MS } from "../motion/motionTokens";
import type { ScrollRef, ViewRef } from "nsh";
import { sectionCollapseAnchorScrollTop } from "./pullRequestSummaryScroll";

const COMMENT_PAGE = 10;

function scheme(): Scheme {
  return settingValue("colorScheme") === "light" ? "light" : "dark";
}

export function MetaRow(props: { icon: string; label: string; children: unknown }) {
  return (
    <View class="min-h-6 min-w-0 flex-row items-center gap-2">
      <View class="w-24 flex-row items-center gap-1.5"><PRIcon name={props.icon} size={14} /><Text class="text-xs text-muted-foreground">{props.label}</Text></View>
      <View class="min-w-0 flex-1 flex-row flex-wrap items-center gap-1.5">{props.children as never}</View>
    </View>
  );
}

/** A collapsible section: a muted heading with a chevron, `actions` at its right, the body at px-4 pb-4. */
export function Section(props: { title: string; defaultOpen?: boolean; keepMounted?: boolean; actions?: unknown; children: unknown; beforeCollapse?: (section: ViewRef | null, heading: ViewRef | null) => Promise<void> }) {
  const open = signal(props.defaultOpen !== false);
  let section: ViewRef | null = null;
  let heading: ViewRef | null = null;
  let pending = false;
  let disposed = false;
  cleanup(() => { disposed = true; });
  const toggle = async () => {
    if (pending) return;
    if (open() && props.beforeCollapse) {
      pending = true;
      try { await props.beforeCollapse(section, heading); } finally { pending = false; }
    }
    if (!disposed) toggleWithLayout(COLLAPSE_MS, () => open.set(!open()));
  };
  return (
    <View ref={(node: ViewRef | null) => { section = node; }} class="flex-col" accessibilityLabel={props.title}>
      <View ref={(node: ViewRef | null) => { heading = node; }} class="w-full flex-row items-center bg-background pr-4" style={{ position: "sticky", top: 0, zIndex: 10 }}>
        <View role="button" accessibilityLabel={`${props.title} section`} accessibilityState={{ expanded: open() }} onPress={() => void toggle()} class="min-w-0 flex-1 flex-row items-center gap-1.5 px-4 py-3">
          <Text class="text-xs font-medium text-muted-foreground">{props.title}</Text>
          <PRIcon name={open() ? "chevron-down" : "chevron-right"} size={14} />
        </View>
        {props.actions as never}
      </View>
      <View class="overflow-hidden">{props.keepMounted || open() ? <View class={open() ? "flex-col px-4 pb-4" : "hidden"}>{props.children as never}</View> : null}</View>
    </View>
  );
}

function LabelChip(props: { label: DetailLabel }) {
  const color = pullRequestLabelColor(props.label.color);
  const dark = () => colorScheme() === "dark";
  return (
    <View
      class={color ? "h-4.5 min-w-4.5 max-w-48 shrink items-center justify-center rounded-sm px-1" : "h-4.5 min-w-4.5 max-w-48 shrink items-center justify-center rounded-sm bg-secondary px-1"}
      style={color ? { backgroundColor: `${color}${dark() ? "1f" : "14"}` } : undefined}
    >
      <Text class="truncate text-xs font-medium text-foreground" style={color ? { color: mixColors(color, String(token("foreground")), dark() ? 0.45 : 0.3) } : undefined}>{props.label.name}</Text>
    </View>
  );
}

const OUTCOME_TONE: Record<string, { light: string; dark: string }> = {
  approved: { light: "#059669", dark: "#6ee7b7" },
  "changes-requested": { light: "#dc2626", dark: "#f87171" },
};

function ReviewerAvatars(props: { entries: ReturnType<typeof reviewerEntries> }) {
  return (
    <View class="flex-row items-center">
      <Each of={props.entries} key={(entry: ReviewerEntry) => entry.key}>
        {(entry) => {
          const login = entry().actor?.login ?? "ghost";
          const name = entry().actor?.name;
          const named = name && name !== login ? `${name} (@${login})` : login;
          const label = entry().outcome ? (entry().stale ? reviewOutcomeStaleLabel(entry().outcome!) : REVIEW_OUTCOME_LABEL[entry().outcome!]) : null;
          const ring = entry().outcome && OUTCOME_TONE[entry().outcome!] ? toneColor(OUTCOME_TONE[entry().outcome!]!, scheme()) : null;
          return (
            <View
              tooltip={label ? `${named}: ${label}` : named}
              accessibilityLabel={label ? `${login}, ${label}` : login}
              class="-ml-1 rounded-full first:ml-0"
              style={ring ? { borderWidth: 2, borderColor: ring, opacity: entry().stale ? 0.65 : 1 } : undefined}
            >
              <PullRequestActorAvatar actor={entry().actor} />
            </View>
          );
        }}
      </Each>
    </View>
  );
}

function CommentCard(props: { comment: DetailComment; detail: PullRequestDetailData; model: PullRequestDetailModel; now: () => number; onFixFinding?: (finding: PullRequestFinding) => void; pendingFinding?: () => string | null; fixLabel?: () => string }) {
  const comment = () => props.comment;
  const actions = props.model.actions;
  const editing = signal(false);
  const edited = signal<string | null>(null);
  const kind = () => comment().kind === "issue-comment" ? "issue-comment" as const : comment().kind === "review-comment" ? "review-comment" as const : null;
  const outcome = () => reviewOutcome(comment().reviewState);
  const body = () => edited() ?? comment().body;
  const shown = () => visibleBody(body());
  const hover = createHover();
  return (
    <View class="min-w-0 flex-col rounded-lg border border-border-60 bg-background" accessibilityLabel={`Comment by ${comment().author?.login ?? "ghost"}`} {...hover.bind}>
      <View role="heading" class="flex-row flex-wrap items-center gap-2 rounded-t-lg px-3 py-2.5" style={{ backgroundColor: tokenAlpha("muted", 0.25) }}>
        <PullRequestActorLabel actor={comment().author} />
        {outcome() ? <Text class="text-xs text-muted-foreground">{REVIEW_OUTCOME_LABEL[outcome()!]}</Text> : null}
        <Text class="text-xs text-muted-foreground">{relativeTime(comment().createdAt, props.now())}</Text>
        {comment().editedAt ? <Text class="text-xs text-muted-foreground">edited</Text> : null}
        {props.onFixFinding && (comment().kind === "review" || comment().kind === "review-comment") && outcome() !== "approved" && outcome() !== "dismissed" && shown() !== null ? (
          <View role="button" accessibilityLabel={props.fixLabel?.() ?? "Fix in a thread"} accessibilityState={{ disabled: (props.pendingFinding?.() ?? null) !== null }} onPress={() => { if ((props.pendingFinding?.() ?? null) === null) props.onFixFinding!({ kind: "comment", comment: comment() }); }} class="ml-auto h-6 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent-50">
            <PRIcon name="hammer" size={12} /><Text class="text-xs text-foreground">{props.pendingFinding?.() === findingKey({ kind: "comment", comment: comment() }) ? "Preparing..." : (props.fixLabel?.() ?? "Fix in a thread")}</Text>
          </View>
        ) : null}
        {props.detail.capabilities.reactions === true || comment().reactions.length > 0 ? <View class="ml-auto"><PullRequestReactionBar reactions={() => comment().reactions} canReact={() => props.detail.capabilities.reactions === true} onToggle={(content, reacted) => actions.setReaction(comment().id, content, reacted)} /></View> : null}
      </View>
      {comment().path ? <Text class="px-3 pt-2 font-mono text-xs text-muted-foreground">{comment().path}</Text> : null}
      {editing() && kind() ? (
        <View class="px-3 py-3">
          <PullRequestMarkdownEditor
            value={body()}
            label="Edit comment"
            completion={actions.completion()}
            saving={() => actions.pending() === `edit:${comment().id}`}
            onSave={(next) => { const currentKind = kind(); if (currentKind) void actions.updateComment(comment().id, currentKind, next).then((saved) => { if (saved) { edited.set(next); editing.set(false); } }); }}
            onCancel={() => editing.set(false)}
          />
        </View>
      ) : shown() !== null ? (
        <View class="flex-row items-start gap-1 px-3 py-3">
          <PullRequestCommentBody class="min-w-0 flex-1" text={() => shown() ?? ""} provider={props.detail.provider} />
          {kind() && canEditPullRequestComment(props.detail, comment()) ? <PullRequestEditButton label="Edit comment" onPress={() => editing.set(true)} hovered={hover.hovered} /> : null}
        </View>
      ) : null}
    </View>
  );
}

export function ConversationRow(props: { item: ConversationItem; detail: PullRequestDetailData; model: PullRequestDetailModel; now: () => number; onFixFinding?: (finding: PullRequestFinding) => void; pendingFinding?: () => string | null; fixLabel?: () => string }) {
  const comment = () => props.item.kind === "comment" ? props.item.comment : null;
  const thread = () => props.item.kind === "thread" ? props.item.thread : null;
  if (props.item.kind === "comment") return <CommentCard comment={comment()!} detail={props.detail} model={props.model} now={props.now} {...(props.onFixFinding ? { onFixFinding: props.onFixFinding } : {})} {...(props.pendingFinding ? { pendingFinding: props.pendingFinding } : {})} {...(props.fixLabel ? { fixLabel: props.fixLabel } : {})} />;
  const review = props.model.review;
  return (
    <ReviewThreadCard summary thread={thread()!} actions={props.model.actions} canReply={review.canReply} canResolve={() => review.canResolve(thread()!)} canReact={review.canReact} now={props.now} {...(props.onFixFinding && !thread()!.isResolved ? { onFix: () => props.onFixFinding!({ kind: "thread", thread: thread()! }), fixPending: () => props.pendingFinding?.() === findingKey({ kind: "thread", thread: thread()! }), fixDisabled: () => (props.pendingFinding?.() ?? null) !== null } : {})} {...(props.fixLabel ? { fixLabel: props.fixLabel } : {})} />
  );
}

/** COMMENT_FILTER_STORAGE_KEY: the Summary's comment filter outlives the panel (useLocalStorage, JSON). */
const COMMENT_FILTER_STORAGE_KEY = "t3code:pull-request-comment-filter:v1";
const savedCommentFilter = signal<CommentFilter>(DEFAULT_COMMENT_FILTER);
let commentFilterChosen = false;
export function readSavedCommentFilter(text: string | null): CommentFilter | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return typeof value.bots === "boolean" && typeof value.resolved === "boolean" ? { bots: value.bots, resolved: value.resolved } : null;
  } catch { return null; }
}
void Storage.getItem(COMMENT_FILTER_STORAGE_KEY).then((text) => { const saved = readSavedCommentFilter(text); if (saved && !commentFilterChosen) savedCommentFilter.set(saved); }).catch(() => {});
function chooseCommentFilter(next: CommentFilter) {
  commentFilterChosen = true;
  savedCommentFilter.set(next);
  void Storage.setItem(COMMENT_FILTER_STORAGE_KEY, JSON.stringify(next)).catch(() => {});
}

export function PullRequestSummaryTab(props: {
  detail: () => PullRequestDetailData;
  model: PullRequestDetailModel;
  now: () => number;
  onOpenLink: (url: string) => void;
  /** A check's Details link; a failure toasts "Unable to open check details". */
  onOpenCheck?: (url: string) => void;
  /** checksStale: "Check details are out of date." with Refresh. */
  checksStale?: () => boolean;
  onRefreshChecks?: () => void;
  /** "Fix" on a failing check; `pendingFinding` names the one being prepared. */
  onFixFinding?: (finding: PullRequestFinding) => void;
  pendingFinding?: () => string | null;
  /** pullRequestHandoffLabels().fixCheck: "Fix in this thread" beside a composer. */
  fixCheckLabel?: () => string;
  fixFindingLabel?: () => string;
}) {
  const model = props.model;
  const detail = props.detail;
  const filter = Object.assign(() => savedCommentFilter(), { set: chooseCommentFilter });
  const order = signal<"newest" | "oldest">("newest");
  const shown = signal(COMMENT_PAGE);
  const descriptionEditing = signal(false);
  const descriptionHover = createHover();
  const filterOpen = signal(false);
  const filterAnchor = createAnchor();
  let selectedUrl = detail().url;
  effect(() => {
    const url = detail().url;
    if (url === selectedUrl) return;
    selectedUrl = url;
    descriptionEditing.set(false);
    shown.set(COMMENT_PAGE);
  });

  const items = () => conversationItems(model.activity());
  const filtered = () => filterConversation(items(), filter());
  const hidden = () => conversationCommentCount(items()) - conversationCommentCount(filtered());
  const page = () => pageConversations(filtered(), shown(), order());
  const showOlder = () => page().hidden > 0 ? (
    <View role="button" accessibilityLabel="Show more comments" onPress={() => shown.set(shown() + COMMENT_PAGE)} class="h-7 items-center justify-center rounded-md border border-border hover:bg-accent-50"><Text class="text-sm text-foreground">{`Show ${Math.min(COMMENT_PAGE, page().hidden)} older conversation${page().hidden === 1 ? "" : "s"} (${page().hidden} hidden)`}</Text></View>
  ) : null;
  const term = () => changeRequestTerm(detail().provider);
  const description = () => detail().body;
  const canReactDescription = () => detail().capabilities.reactions === true;
  const descriptionReactions = (): ReviewReaction[] => model.activity()?.reactions ?? [];
  let scroller: ScrollRef | null = null;
  let scrollTop = 0;
  const beforeCollapse = async (section: ViewRef | null, heading: ViewRef | null) => {
    const scroll = scroller;
    if (!scroll || !section || !heading) return;
    const initialTop = scrollTop;
    try {
      const [viewportBox, sectionBox, headingBox] = await Promise.all([scroll.measure(), section.measure(), heading.measure()]);
      if (!viewportBox || !sectionBox || !headingBox || scroller !== scroll || scrollTop !== initialTop) return;
      const target = sectionCollapseAnchorScrollTop({ scrollTop: initialTop, viewportTop: viewportBox.pagePosition.y, sectionTop: sectionBox.pagePosition.y, headingTop: headingBox.pagePosition.y });
      if (target !== null) scroll.scrollTo({ y: target, animated: false });
    } catch { /* An unmounted or unmeasurable section can still collapse normally. */ }
  };

  return (
    <Scroll ref={(node: ScrollRef | null) => { scroller = node; }} onScroll={(event) => { scrollTop = event.offset.y; }} class="min-h-0 flex-1" accessibilityLabel="Pull request summary">
      <View class="flex-col">
        <View class="flex-col gap-2 px-4 pb-1 pt-2.5">
          <MetaRow icon="users" label="Reviewers">
            {reviewerEntries(detail(), model.activity()).length === 0 ? <Text class="text-xs text-muted-foreground">None</Text> : <ReviewerAvatars entries={reviewerEntries(detail(), model.activity())} />}
            <PullRequestReviewerPicker gate={detail().reviewerPicker} actions={model.actions} />
          </MetaRow>
          {detail().labels.length > 0 || detail().capabilities.labels ? (
            <MetaRow icon="tag" label="Labels">
              {detail().labels.length === 0 ? <Text class="text-xs text-muted-foreground">None</Text> : detail().labels.map((label) => <LabelChip label={label} />)}
              <PullRequestLabelPicker detail={detail} actions={model.actions} />
            </MetaRow>
          ) : null}
        </View>

        <Section title="Description" keepMounted beforeCollapse={beforeCollapse}>
          <View class="flex-col gap-2" {...descriptionHover.bind}>
            {descriptionEditing() ? (
              <PullRequestMarkdownEditor
                value={description()}
                label={`${term().replace(/^./u, (c) => c.toUpperCase())} description`}
                placeholder={`Describe this ${term()}`}
                completion={model.actions.completion()}
                allowEmpty
                saving={() => model.actions.pending() === "description"}
                onSave={(next) => { const url = detail().url; void model.actions.updateBody(next).then((saved) => { if (saved && detail().url === url) descriptionEditing.set(false); }); }}
                onCancel={() => descriptionEditing.set(false)}
              />
            ) : (
              <View class="flex-row items-start gap-1">
                <PullRequestMarkdown class="min-w-0 flex-1" provider={detail().provider} text={description().trim().length > 0 ? description() : "_No description provided._"} />
                {detail().canEditTitle ? <PullRequestEditButton label="Edit description" onPress={() => descriptionEditing.set(true)} hovered={descriptionHover.hovered} /> : null}
              </View>
            )}
            {canReactDescription() || descriptionReactions().length > 0 ? (
              <PullRequestReactionBar reactions={descriptionReactions} canReact={canReactDescription} onToggle={(content, reacted) => model.actions.setReaction(undefined, content, reacted)} />
            ) : null}
          </View>
        </Section>

        <Section title="Checks" defaultOpen={false} beforeCollapse={beforeCollapse}>
          {props.checksStale?.() ? (
            <View class="flex-row items-center gap-2">
              <Text class="text-xs text-muted-foreground">Check details are out of date.</Text>
              <View role="button" accessibilityLabel="Refresh" onPress={() => props.onRefreshChecks?.()} class="h-6 justify-center rounded-md px-2 hover:bg-accent-50"><Text class="text-xs text-foreground">Refresh</Text></View>
            </View>
          ) : detail().checks.length === 0 ? <Text class="text-xs text-muted-foreground">No checks reported.</Text> : (
            <View class="flex-col">
              <Each of={detail().checks} key={(check: { name: string }, index: number) => `${index}:${check.name}`}>
                {(check) => {
                  const status = CHECK_STATUS[check().status] ?? { label: check().status, icon: "circle-dashed" };
                  const tint = check().status === "success" ? toneColor({ light: "#059669", dark: "#6ee7b7" }, scheme())
                    : check().status === "failure" || check().status === "cancelled" ? toneColor({ light: "#dc2626", dark: "#f87171" }, scheme())
                      : check().status === "pending" || check().status === "action-required" ? toneColor({ light: "#d97706", dark: "#fbbf24" }, scheme()) : undefined;
                  return (
                    <View class="min-w-0 flex-row items-center gap-2 rounded-md pr-1 hover:bg-accent-50">
                      <View role="button" accessibilityLabel={`Check ${check().name}`} disabled={!check().url} onPress={() => { if (check().url) (props.onOpenCheck ?? props.onOpenLink)(check().url); }} class="min-w-0 flex-1 flex-row items-start gap-2 rounded-md px-2 py-2">
                        <PRIcon name={status.icon} size={14} tint={tint} />
                        <Text class="min-w-0 flex-1 text-xs text-foreground">{check().name}</Text>
                        <Text class="shrink-0 text-xs text-muted-foreground">{checkStatusLabel(check())}</Text>
                      </View>
                      {props.onFixFinding && (check().status === "failure" || check().status === "cancelled") ? (
                        <View role="button" accessibilityLabel={`Fix ${check().name}`} disabled={(props.pendingFinding?.() ?? null) !== null}
                          onPress={() => { if ((props.pendingFinding?.() ?? null) === null) props.onFixFinding!({ kind: "check", check: check() }); }}
                          class="h-6 shrink-0 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent-50">
                          <PRIcon name="hammer" size={12} />
                          <Text class="text-xs text-foreground">{props.pendingFinding?.() === findingKey({ kind: "check", check: check() }) ? "Preparing..." : (props.fixCheckLabel?.() ?? FIX_LABELS.fixCheck)}</Text>
                        </View>
                      ) : null}
                    </View>
                  );
                }}
              </Each>
            </View>
          )}
        </Section>

        <Section
          title={`Comments (${totalConversationComments(model.activity())})`}
          beforeCollapse={beforeCollapse}
          actions={
            <View class="shrink-0 flex-row items-center gap-1">
              <View ref={filterAnchor.ref} role="button" accessibilityLabel="Filter comments" onPress={() => filterOpen.set(!filterOpen())} class="h-6 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent-50">
                <PRIcon name="list-filter" size={12} />
                <Text class="text-xs text-muted-foreground">{hidden() > 0 ? `${hidden()} hidden` : "Filter"}</Text>
              </View>
              {filterOpen() ? (
                <Popup anchor={filterAnchor.anchor} onClose={() => filterOpen.set(false)} placement="bottom" align="end" class="min-w-48">
                  <View class="flex-col p-1">
                    <Text class="px-2 py-1 text-xs text-muted-foreground">Show</Text>
                    <View role="checkbox" accessibilityLabel="Bot comments" accessibilityState={{ checked: filter().bots }} onPress={() => filter.set({ ...filter(), bots: !filter().bots })} class="h-8 flex-row items-center gap-2 rounded-sm px-2 hover:bg-accent-50">
                      <View class="size-4 items-center justify-center">{filter().bots ? <PRIcon name="check" size={14} /> : null}</View>
                      <Text class="text-sm text-foreground">Bot comments</Text>
                    </View>
                    <View role="checkbox" accessibilityLabel="Resolved or dismissed" accessibilityState={{ checked: filter().resolved }} onPress={() => filter.set({ ...filter(), resolved: !filter().resolved })} class="h-8 flex-row items-center gap-2 rounded-sm px-2 hover:bg-accent-50">
                      <View class="size-4 items-center justify-center">{filter().resolved ? <PRIcon name="check" size={14} /> : null}</View>
                      <Text class="text-sm text-foreground">Resolved or dismissed</Text>
                    </View>
                  </View>
                </Popup>
              ) : null}
              <View role="button" accessibilityLabel={order() === "newest" ? "Show oldest comments first" : "Show newest comments first"} onPress={() => order.set(order() === "newest" ? "oldest" : "newest")} class="h-6 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent-50">
                <PRIcon name="arrow-up-down" size={12} />
                <Text class="text-xs text-muted-foreground">{order() === "newest" ? "Newest first" : "Oldest first"}</Text>
              </View>
            </View>
          }
        >
          {!model.activity() && !model.activityError() ? <PullRequestConversationGhost term={term()} /> : null}
          {model.activityError() ? <PullRequestActivityUnavailableState compact error={model.activityError()} term={term()} onRetry={() => void model.refresh()} /> : null}
          {model.activity() ? (
            <View class="flex-col gap-3">
              {model.activity()!.truncated ? (
                <Text class="rounded-md border border-warning bg-warning-surface px-2 py-1.5 text-xs text-foreground">{`This conversation is only partially loaded. ${model.activity()!.comments.length} ${model.activity()!.comments.length === 1 ? "comment is" : "comments are"} loaded; open it on the host to read the rest.`}</Text>
              ) : null}
              {items().length === 0 ? <Text class="py-2 text-xs text-muted-foreground">No comments yet.</Text>
                : filtered().length === 0 ? <Text class="py-2 text-xs text-muted-foreground">{hidden() === 1 ? "The only comment is hidden by the filter." : `All ${hidden()} comments are hidden by the filter.`}</Text>
                  : (
                    <View class="flex-col gap-3">
                      {order() === "oldest" ? showOlder() : null}
                      <Each of={page().visible} key={(item: ConversationItem) => `${item.kind}:${item.id}`}>
                        {(item) => <ConversationRow item={item()} detail={detail()} model={model} now={props.now} {...(props.onFixFinding ? { onFixFinding: props.onFixFinding } : {})} {...(props.pendingFinding ? { pendingFinding: props.pendingFinding } : {})} {...(props.fixFindingLabel ? { fixLabel: props.fixFindingLabel } : {})} />}
                      </Each>
                      {order() === "newest" ? showOlder() : null}
                      {shown() > COMMENT_PAGE ? <View role="button" accessibilityLabel="Show only recent conversations" onPress={() => shown.set(COMMENT_PAGE)} class="h-7 items-center justify-center rounded-md hover:bg-accent-50"><Text class="text-sm text-foreground">{`Show only ${COMMENT_PAGE} recent conversations`}</Text></View> : null}
                    </View>
                  )}
            </View>
          ) : null}
        </Section>
      </View>
    </Scroll>
  );
}


