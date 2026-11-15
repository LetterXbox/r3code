// What sits under a diff line: the host's review threads, the viewer's pending comments and the draft
// being written, ported from PullRequestReviewAnnotation.tsx (the cards) and the draft annotation of
// PullRequestCodeTab.tsx.
import { signal, Text, View } from "nsh";
import { createHover } from "../hoverReveal";
import { tokenAlpha } from "../composer/tokenColor";
import { PRIcon } from "./PRIcon";
import { PullRequestActorLabel } from "./PullRequestActorLabel";
import { PullRequestCommentBody } from "./PullRequestCommentBody";
import { PullRequestEditButton } from "./PullRequestEditButton";
import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";
import { PullRequestMarkdownTextarea, type PullRequestCompletionScope } from "./PullRequestMarkdownTextarea";
import { PullRequestMoreReplies } from "./PullRequestMoreReplies";
import { PullRequestReactionBar } from "./PullRequestReactions";
import { relativeTime } from "./pullRequestPresentation";
import { mergeThreadComments, positionAnchor, type PendingReviewComment, type ReviewThread, type ReviewThreadComment } from "./pullRequestReview.logic";
import type { PullRequestActionsModel } from "./pullRequestActionsModel";

const CARD = "mx-3 my-2 flex-col rounded-xl border border-border-60 bg-background p-3";

function GhostButton(props: { label: string; name?: string; icon?: string; disabled?: boolean; onPress: () => void; end?: boolean }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.name ?? props.label}
      accessibilityState={{ disabled: props.disabled === true }}
      onPress={() => { if (!props.disabled) props.onPress(); }}
      class={`h-6 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent-50 ${props.end ? "ml-auto" : ""} ${props.disabled ? "opacity-50" : ""}`}
    >
      {props.icon ? <PRIcon name={props.icon} size={12} /> : null}
      <Text class="text-xs text-foreground">{props.label}</Text>
    </View>
  );
}

export function PendingReviewCommentCard(props: { comment: PendingReviewComment; onRemove: () => void }) {
  return (
    <View class={`${CARD} border-dashed`} accessibilityLabel="Pending review comment">
      <View class="flex-row items-center gap-2">
        <PRIcon name="message-square" size={14} />
        <Text class="min-w-0 flex-1 text-xs text-muted-foreground">Pending. Sent when you submit the review</Text>
        <View role="button" accessibilityLabel="Discard this comment" onPress={props.onRemove} class="size-6 items-center justify-center rounded-md hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out"><PRIcon name="trash-2" size={14} /></View>
      </View>
      <Text class="mt-2 text-sm text-foreground">{props.comment.body}</Text>
    </View>
  );
}

export function ReviewThreadCard(props: {
  thread: ReviewThread;
  /** Summary renders each comment as its own card with replies indented. */
  summary?: boolean;
  actions: PullRequestActionsModel;
  canReply: () => boolean;
  canResolve: () => boolean;
  canReact: () => boolean;
  now: () => number;
  /** Absent where no composer sits beside the panel to add the conversation to. */
  onFix?: () => void;
  /** pullRequestHandoffLabels().fixFinding: "Fix" beside a composer. */
  fixLabel?: () => string;
  /** "Fix in a thread" is being prepared for this conversation (shown as "Preparing..."). */
  fixPending?: () => boolean;
  fixDisabled?: () => boolean;
  /** Absent where there is no composer beside the panel to add the conversation to. Handed the thread with every comment loaded. */
  onAddToChat?: (thread: ReviewThread) => void;
}) {
  const thread = () => props.thread;
  const actions = props.actions;
  const expanded = signal(!thread().isResolved);
  const replying = signal(false);
  const reply = signal("");
  const editingId = signal<string | null>(null);
  const loaded = signal<{ comments: ReviewThreadComment[]; nextCursor: string | null } | null>(null);
  const loadingMore = signal(false);
  const edited = signal<Record<string, string>>({});

  const comments = () => {
    const merged = mergeThreadComments(thread().comments, loaded()?.comments ?? []);
    return merged.map((comment) => (edited()[comment.id] === undefined ? comment : { ...comment, body: edited()[comment.id] as string }));
  };
  const nextCursor = () => (loaded() === null ? thread().nextCommentsCursor : loaded()!.nextCursor);
  const commentCount = () => thread().commentCount || comments().length;
  const busy = () => actions.pending() !== null;
  const sending = () => actions.pending() === `thread:${thread().id}`;

  async function send() {
    const body = reply().trim();
    if (body.length === 0 || busy()) return;
    if (await actions.replyToThread(thread().id, body)) {
      // A reply returns no comment: keep what is loaded and reopen paging for a later read.
      if (loaded() !== null && loaded()!.nextCursor === null && thread().nextCommentsCursor) loaded.set({ ...loaded()!, nextCursor: thread().nextCommentsCursor });
      reply.set("");
      replying.set(false);
    }
  }

  async function loadMore() {
    const cursor = nextCursor();
    if (cursor === null || loadingMore()) return;
    loadingMore.set(true);
    const page = await actions.loadThreadComments(thread().id, cursor);
    loadingMore.set(false);
    if (page === null) return;
    loaded.set({ comments: mergeThreadComments(loaded()?.comments ?? [], page.comments), nextCursor: page.nextCursor });
  }

  async function saveEdit(commentId: string, body: string) {
    if (await actions.updateComment(commentId, "review-comment", body, "The comment could not be saved")) {
      edited.update((all) => ({ ...all, [commentId]: body }));
      editingId.set(null);
    }
  }

  return (
    <View class={props.summary ? "flex-col gap-2" : CARD} accessibilityLabel={`Review thread ${thread().path}`}>
      {!props.summary || thread().isResolved ? <View class="flex-row items-center gap-2">
        <PRIcon name={thread().isResolved ? "circle-check" : "circle"} size={14} />
        <View role="button" accessibilityLabel={`${thread().isResolved ? "Resolved" : "Open"}, ${commentCount()} ${commentCount() === 1 ? "comment" : "comments"}`} accessibilityState={{ expanded: expanded() }} onPress={() => expanded.set(!expanded())}>
          <Text class="text-xs text-muted-foreground">{`${thread().isResolved ? "Resolved" : "Open"} · ${commentCount()} ${commentCount() === 1 ? "comment" : "comments"}`}</Text>
        </View>
        {thread().isOutdated ? <Text class="text-xs text-muted-foreground">outdated</Text> : null}
        {props.onFix ? <GhostButton label={props.fixPending?.() ? "Preparing..." : (props.fixLabel?.() ?? "Fix in a thread")} name={props.fixLabel?.() ?? "Fix in a thread"} icon="hammer" disabled={busy() || props.fixDisabled?.() === true} onPress={props.onFix} end /> : null}
        {props.onAddToChat && comments().some((comment) => comment.body.trim().length > 0) ? <GhostButton label="Add to chat" icon="message-square-plus" onPress={() => props.onAddToChat!({ ...thread(), comments: comments() })} end={!props.onFix} /> : null}
        {props.canResolve() ? <GhostButton label={thread().isResolved ? "Unresolve" : "Resolve"} disabled={busy()} onPress={() => void actions.setThreadResolved(thread().id, !thread().isResolved)} end={!props.onFix && !props.onAddToChat} /> : null}
      </View> : null}
      {expanded() ? (
        <View class="flex-col">
          <View class={props.summary ? "flex-col gap-2" : "mt-2 flex-col gap-3"}>
            <Each of={comments()} key={(comment: ReviewThreadComment) => comment.id}>
              {(comment, index) => {
                const hover = createHover();
                return (
                <View class={props.summary && index() > 0 ? "ml-4 flex-col border-l-2 border-border-60 pl-3" : "min-w-0 flex-col"}>
                <View class={props.summary ? "min-w-0 flex-col rounded-lg border border-border-60" : "min-w-0 flex-col"} testID={props.summary ? (index() === 0 ? "review-summary-root" : "review-summary-reply") : undefined} accessibilityLabel={`Comment by ${comment().author?.login ?? "ghost"}`} {...hover.bind}>
                  <View class={props.summary ? "flex-row flex-wrap items-center gap-2 rounded-t-lg px-3 py-2.5" : "flex-row flex-wrap items-center gap-2"} style={props.summary ? { backgroundColor: tokenAlpha("muted", 0.25) } : undefined}>
                    <PullRequestActorLabel actor={comment().author} />
                    <Text class="text-xs text-muted-foreground">{relativeTime(comment().createdAt, props.now())}</Text>
                    {props.summary && index() === 0 && !thread().isResolved && props.onFix ? <GhostButton label={props.fixPending?.() ? "Preparing..." : (props.fixLabel?.() ?? "Fix in a thread")} name={props.fixLabel?.() ?? "Fix in a thread"} icon="hammer" disabled={busy() || props.fixDisabled?.() === true} onPress={props.onFix} end /> : null}
                    <View class="ml-auto">
                      <PullRequestReactionBar
                        reactions={() => comment().reactions}
                        canReact={props.canReact}
                        onToggle={(content, reacted) => actions.setReaction(comment().id, content, reacted)}
                      />
                    </View>
                  </View>
                  {props.summary && index() === 0 ? <Text class="px-3 pt-2 font-mono text-xs text-muted-foreground">{`${thread().path}${thread().line !== null ? `:${thread().line}` : ""}${thread().isOutdated ? "  Outdated" : ""}`}</Text> : null}
                  {editingId() === comment().id ? (
                    <View class="mt-1">
                      <PullRequestMarkdownEditor value={comment().body} label="Edit comment" saving={() => actions.pending() === `edit:${comment().id}`} onSave={(body) => void saveEdit(comment().id, body)} onCancel={() => editingId.set(null)} />
                    </View>
                  ) : (
                    <View class={props.summary ? "flex-row items-start gap-1 px-3 py-3" : "mt-1 flex-row items-start gap-1"}>
                      <PullRequestCommentBody class="min-w-0 flex-1" text={() => comment().body} />
                      {comment().canEdit ? <PullRequestEditButton label="Edit comment" onPress={() => editingId.set(comment().id)} hovered={hover.hovered} /> : null}
                    </View>
                  )}
                </View>
                </View>
                );
              }}
            </Each>
          </View>
          {props.summary && !thread().isResolved && props.canResolve() ? <View class="flex-row justify-end"><GhostButton label="Resolve" disabled={busy()} onPress={() => void actions.setThreadResolved(thread().id, true)} /></View> : null}
          {props.summary && (commentCount() > comments().length || nextCursor() !== null) ? (
            <View class="px-3"><PullRequestMoreReplies moreReplies={Math.max(0, commentCount() - comments().length)} hasMoreReplies url={comments().find((comment) => !!comment.url)?.url ?? null} /></View>
          ) : null}
          {nextCursor() !== null ? <View class="mt-2 flex-row"><GhostButton label={loadingMore() ? "Loading..." : "Load more comments"} disabled={loadingMore()} onPress={() => void loadMore()} /></View> : null}
          {props.canReply() ? (
            replying() ? (
              <View class="mt-2 flex-col">
                <PullRequestMarkdownTextarea autoFocus size="sm" value={reply()} placeholder="Reply" label="Reply to this conversation" disabled={busy()} completion={actions.completion()} onValueChange={(next) => reply.set(next)} onModEnter={() => { if (!busy() && reply().trim().length > 0) void send(); }} onEscape={() => { if (!busy()) replying.set(false); }} />
                <View class="mt-2 flex-row flex-wrap items-center justify-end gap-2">
                  <GhostButton label="Cancel" onPress={() => replying.set(false)} />
                  <View
                    role="button"
                    accessibilityLabel="Reply"
                    onPress={() => void send()}
                    class={busy() || reply().trim().length === 0 ? "h-6 flex-row items-center rounded-md bg-primary px-2 opacity-50 active:scale-[0.97] transition-transform duration-150 ease-in-out" : "h-6 flex-row items-center rounded-md bg-primary px-2 active:scale-[0.97] transition-transform duration-150 ease-in-out"}
                  >
                    <Text class="text-xs font-medium text-primary-foreground">{sending() ? "Replying..." : "Reply"}</Text>
                  </View>
                </View>
              </View>
            ) : <View class="mt-2 flex-row"><GhostButton label="Reply" onPress={() => replying.set(true)} /></View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** The draft's rangeLabel: `path:line` of the line the comment ends on (DiffCommentAnnotation). */
export function draftRangeLabel(draft: { path: string; position: PendingReviewComment["position"] }): string {
  return `${draft.path}:${positionAnchor(draft.position).line}`;
}

/** The form under a line being commented on. `submitLabel` is "Add to review" when the host takes inline comments, else "Add to agent". */
export function DiffCommentForm(props: {
  rangeLabel: string; submitLabel: string; onCancel: () => void; onComment: (body: string) => void;
  /** A second way to send the text, beside the review button ("Add to agent" when the host also takes inline comments). */
  secondaryAction?: { label: string; onAction: (text: string) => void };
  completion?: PullRequestCompletionScope | null;
  /** The field's placeholder; "Leave a comment" by default. */
  placeholder?: string;
}) {
  const text = signal("");
  const empty = () => text().trim().length === 0;
  const submit = () => { const body = text().trim(); if (body.length > 0) props.onComment(body); };
  return (
    <View class={CARD} accessibilityLabel="Comment on this line">
      <Text class="mb-2 font-mono text-xs text-muted-foreground">{props.rangeLabel}</Text>
      <PullRequestMarkdownTextarea autoFocus size="sm" value={text()} placeholder={props.placeholder ?? "Leave a comment"} label="Line comment" completion={props.completion ?? null} onValueChange={(next) => text.set(next)} onModEnter={submit} onEscape={props.onCancel} />
      <View class="mt-2 flex-row flex-wrap items-center justify-end gap-2">
        <GhostButton label="Cancel" onPress={props.onCancel} />
        {props.secondaryAction ? <View role="button" accessibilityLabel={props.secondaryAction.label} onPress={() => { const body = text().trim(); if (body.length > 0) props.secondaryAction?.onAction(body); }} class={empty() ? "h-6 flex-row items-center rounded-md border border-border px-2 opacity-50" : "h-6 flex-row items-center rounded-md border border-border px-2 hover:bg-accent-50"}>
          <Text class="text-xs text-foreground">{props.secondaryAction.label}</Text>
        </View> : null}
        <View role="button" accessibilityLabel={props.submitLabel} onPress={submit} class={empty() ? "h-6 flex-row items-center rounded-md bg-primary px-2 opacity-50 active:scale-[0.97] transition-transform duration-150 ease-in-out" : "h-6 flex-row items-center rounded-md bg-primary px-2 active:scale-[0.97] transition-transform duration-150 ease-in-out"}>
          <Text class="text-xs font-medium text-primary-foreground">{props.submitLabel}</Text>
        </View>
      </View>
    </View>
  );
}

