// The Timeline tab, ported from PullRequestTimelineTab.tsx: a vertical rail of events (newest first, or oldest) with an
// avatar or glyph marker each: the pull request opening, commits (open the commit's diff), runs of comments folded
// into one disclosure, review threads with their replies, review verdicts and the merge or close; then the composer.
import { colorScheme, Scroll, signal, Text, View } from "nsh";
import { createHover } from "../hoverReveal";
import { HIcon } from "../header/HeaderIcons";
import { ChevronTurn, toggleWithLayout } from "../motion/Motion";
import { COLLAPSE_MS } from "../motion/motionTokens";
import { showToast } from "../toast";
import { PRIcon } from "./PRIcon";
import type { PullRequestActionsModel } from "./pullRequestActionsModel";
import { PullRequestActivityUnavailableState } from "./PullRequestActivityUnavailableState";
import { PullRequestActorAvatar } from "./PullRequestActorLabel";
import { PullRequestComposer } from "./PullRequestActions";
import { PullRequestCommentBody } from "./PullRequestCommentBody";
import { PullRequestEditButton } from "./PullRequestEditButton";
import { PullRequestTimelineGhost } from "./PullRequestGhosts";
import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";
import { PullRequestMoreReplies } from "./PullRequestMoreReplies";
import { PullRequestReactionBar } from "./PullRequestReactions";
import { changeRequestTerm } from "./pullRequestCheckout.logic";
import { isVerdictStale, newestCommitAt, reviewOutcome, REVIEW_OUTCOME_LABEL, reviewOutcomeStaleLabel, type ReviewOutcome } from "./pullRequestConversation.logic";
import type { PullRequestDetailData } from "./pullRequestDetail.logic";
import type { PullRequestDetailModel } from "./pullRequestDetailModel";
import { formatCount, relativeTime, toneColor } from "./pullRequestPresentation";
import { diffAdditionClass, diffDeletionClass } from "../diff/diffColorScheme";
import { canEditPullRequestComment, type ReviewThread } from "./pullRequestReview.logic";
import {
  buildPullRequestTimelineEvents, friendlyReviewState, groupTimelineConversations, timelineRowKey, uniqueConversationActors, type TimelineEvent, type TimelineRow,
} from "./pullRequestTimeline.logic";

const scheme = () => (colorScheme() === "light" ? "light" as const : "dark" as const);
const OUTCOME_ICON: Record<ReviewOutcome, { icon: string; tone: { light: string; dark: string } }> = {
  approved: { icon: "circle-check", tone: { light: "#059669", dark: "#6ee7b7" } },
  "changes-requested": { icon: "circle-x", tone: { light: "#dc2626", dark: "#f87171" } },
  dismissed: { icon: "circle-dashed", tone: { light: "#a1a1aa", dark: "#71717a" } },
};

interface Surface {
  detail: () => PullRequestDetailData;
  actions: PullRequestActionsModel;
  now: () => number;
  onOpenHost: (url: string) => void;
  /** Absent where there is no composer beside the panel to add a remark to. */
  onAddToChat?: (subject: { kind: "comment"; comment: NonNullable<TimelineEvent["comment"]> }) => void;
}

/** TimelineMarker: the 32 pt slot on the rail, over the line. `at` is where on the row it centres. */
function Marker(props: { at?: "center" | "top-6" | "top-4"; children?: ReturnType<typeof View> }) {
  const at = props.at ?? "center";
  return (
    <View class="absolute left-0 z-10 w-8 items-center justify-center bg-background" style={at === "center" ? { top: 0, bottom: 0 } : { top: at === "top-6" ? 8 : 0, height: 32 }}>
      {props.children}
    </View>
  );
}

function IconMarker(props: { icon: string; at?: "center" | "top-6" | "top-4"; host?: boolean }) {
  return <Marker {...(props.at ? { at: props.at } : {})}><View class="size-7 items-center justify-center bg-background">{props.host ? <HIcon name={props.icon} size={14} /> : <PRIcon name={props.icon} size={14} />}</View></Marker>;
}

function ActorMarker(props: { actors: readonly { login: string; avatarUrl?: string }[]; fallback: string; hostFallback?: boolean; at?: "center" | "top-6" | "top-4"; muted?: boolean; fallbackTint?: string }) {
  const actor = props.actors[0];
  return actor === undefined
    ? <Marker {...(props.at ? { at: props.at } : {})}><View class="size-7 items-center justify-center bg-background">{props.hostFallback ? <HIcon name={props.fallback} size={14} /> : <PRIcon name={props.fallback} size={14} {...(props.fallbackTint ? { tint: props.fallbackTint } : {})} />}</View></Marker>
    : <Marker {...(props.at ? { at: props.at } : {})}><View style={{ opacity: props.muted ? 0.45 : 1 }}><PullRequestActorAvatar actor={actor} size={28} /></View></Marker>;
}

function ActorName(props: { actor: { login: string } | null }) {
  return <Text class="text-xs font-semibold text-foreground">{props.actor?.login ?? "ghost"}</Text>;
}

function Dot() {
  return <Text class="shrink-0 text-2xs text-muted-foreground-70">·</Text>;
}

function OpenOnHostButton(props: { url: string | null; onOpen: (url: string) => void }) {
  return props.url === null ? null : (
    <View role="button" accessibilityLabel="Open activity on host" onPress={() => props.onOpen(props.url!)} class="-mr-1 size-6 shrink-0 items-center justify-center rounded-md hover:bg-accent-50">
      <PRIcon name="external-link" size={12} />
    </View>
  );
}

function AddToChatButton(props: { event: TimelineEvent; surface: Surface }) {
  const onAdd = props.surface.onAddToChat;
  const comment = props.event.comment;
  return onAdd === undefined || comment === undefined ? null : (
    <View role="button" accessibilityLabel="Add to chat" tooltip="Add to chat" onPress={() => onAdd({ kind: "comment", comment })} class="size-6 shrink-0 items-center justify-center rounded-md hover:bg-accent-50">
      <PRIcon name="message-square-plus" size={12} />
    </View>
  );
}

function ConversationCard(props: { event: TimelineEvent; surface: Surface; showPath?: boolean; reply?: boolean }) {
  const event = props.event;
  const surface = props.surface;
  const editing = signal(false);
  const edited = signal<string | null>(null);
  const editable = () => event.comment !== undefined && canEditPullRequestComment(surface.detail(), event.comment);
  const kind = event.comment?.kind === "review-comment" ? "review-comment" as const : "issue-comment" as const;
  const body = () => edited() ?? event.body ?? "";
  const canReact = () => surface.detail().capabilities.reactions === true;
  const hover = createHover();
  return (
    <View class="flex-col py-2" accessibilityLabel={`Comment by ${event.actor?.login ?? "ghost"}`} {...hover.bind}>
      <View class="flex-row flex-wrap items-center gap-2 px-2">
        <View class="min-w-0 flex-1 flex-col">
          <View class="flex-row flex-wrap items-center gap-x-1.5 gap-y-1">
            <ActorName actor={event.actor} />
            <Text class="text-xs text-muted-foreground">{event.title}</Text>
            {event.reviewState ? <Text class="text-2xs font-medium text-muted-foreground">{friendlyReviewState(event.reviewState)}</Text> : null}
          </View>
          <View class="mt-1 flex-row flex-wrap items-center gap-1.5">
            <Text class="text-2xs text-muted-foreground">{relativeTime(event.at, surface.now())}</Text>
            {props.showPath !== false && event.path ? (
              <>
                <Dot />
                <View class="min-w-0 flex-row items-center gap-1"><HIcon name="file" size={12} /><Text class="min-w-0 truncate text-2xs text-muted-foreground">{event.path}</Text></View>
              </>
            ) : null}
          </View>
        </View>
        {editable() && !editing() ? <PullRequestEditButton label="Edit comment" onPress={() => editing.set(true)} hovered={hover.hovered} /> : null}
        {event.body && event.comment && !props.reply ? <AddToChatButton event={event} surface={surface} /> : null}
        {canReact() || event.reactions.length > 0 ? (
          <View class="ml-auto">
            <PullRequestReactionBar reactions={() => event.reactions} canReact={canReact} onToggle={(content, reacted) => surface.actions.setReaction(event.id, content, reacted)} />
          </View>
        ) : null}
        <OpenOnHostButton url={event.url} onOpen={surface.onOpenHost} />
      </View>
      {editing() && event.comment ? (
        <View class="px-2 pb-2 pt-3">
          <PullRequestMarkdownEditor
            value={body()}
            label="Edit comment"
            completion={surface.actions.completion()}
            saving={() => surface.actions.pending() === `edit:${event.id}`}
            onSave={(next) => void surface.actions.updateComment(event.id, kind, next).then((saved) => {
              if (saved) { edited.set(next); editing.set(false); } else showToast({ type: "error", title: "Could not save the comment" });
            })}
            onCancel={() => editing.set(false)}
          />
        </View>
      ) : event.body ? (
        <View class="px-2 pb-2"><TimelineBody body={body()} markdown={event.markdown} /></View>
      ) : null}
    </View>
  );
}

function TimelineBody(props: { body: string; markdown: boolean }) {
  return (
    <View class="mt-3">
      {props.markdown ? <PullRequestCommentBody class="min-w-0" text={() => props.body} /> : <Text class="text-xs text-muted-foreground">{props.body}</Text>}
    </View>
  );
}

function ConversationGroup(props: { events: readonly TimelineEvent[]; surface: Surface }) {
  const open = signal(false);
  const actors = () => uniqueConversationActors(props.events);
  const first = () => props.events[0];
  return first() === undefined ? null : (
    <View class="relative mb-5 pl-12">
      <ActorMarker actors={actors()} at="top-6" fallback="message-square" muted={!open()} />
      <View
        role="button"
        accessibilityLabel={`${props.events.length.toLocaleString("en-US")} ${props.events.length === 1 ? "comment" : "comments"}`}
        accessibilityState={{ expanded: open() }}
        onPress={() => toggleWithLayout(COLLAPSE_MS, () => open.set(!open()))}
        style={{ opacity: open() ? 1 : 0.55 }}
        class="w-full min-w-0 flex-row items-center gap-3 py-2 hover:opacity-100"
      >
        <View class="min-w-0 flex-1 flex-col">
          <Text class={`text-xs font-semibold ${open() ? "text-foreground" : "text-muted-foreground"}`}>{`${props.events.length.toLocaleString("en-US")} ${props.events.length === 1 ? "comment" : "comments"}`}</Text>
          <Text class="truncate text-2xs text-muted-foreground">{`${actors().length.toLocaleString("en-US")} ${actors().length === 1 ? "author" : "authors"} · ${relativeTime(first()!.at, props.surface.now())}`}</Text>
        </View>
        <ChevronTurn open={open} degrees={180}><PRIcon name="chevron-down" size={14} /></ChevronTurn>
      </View>
      <View class="overflow-hidden">
        {open() ? (
          <View class="mt-1 flex-col gap-1">
            <Each of={[...props.events]} key={(event: TimelineEvent) => event.id}>
              {(event) => <ConversationCard event={event()} surface={props.surface} />}
            </Each>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function ReviewThreadEvent(props: { event: TimelineEvent; surface: Surface }) {
  const event = props.event;
  const thread = event.thread!;
  const dismissed = reviewOutcome(event.reviewState) === "dismissed";
  const expanded = signal(!thread.isResolved && !dismissed);
  const replyCount = thread.replies.length + thread.moreReplies;
  return (
    <View class="group relative mb-5 pl-12">
      <ActorMarker actors={event.actor ? [event.actor] : []} at="top-4" fallback="message-square" muted={!expanded()} />
      <View role="button" accessibilityLabel={thread.line === null ? thread.path : `${thread.path}:${thread.line}`} accessibilityState={{ expanded: expanded() }} onPress={() => expanded.set(!expanded())} class="w-full min-w-0 flex-row items-center gap-2 px-2 py-2">
        <HIcon name="file" size={12} />
        <Text class="min-w-0 shrink truncate font-mono text-2xs text-muted-foreground">{thread.line === null ? thread.path : `${thread.path}:${thread.line}`}</Text>
        {thread.isResolved ? (
          <View class="shrink-0 flex-row items-center gap-1">
            <PRIcon name="circle-check" size={12} tint={toneColor({ light: "#059669", dark: "#6ee7b7" }, scheme())} />
            <Text class="text-2xs font-medium text-success-foreground">Resolved</Text>
          </View>
        ) : null}
        {dismissed ? <Text class="shrink-0 text-2xs font-medium text-muted-foreground">Review dismissed</Text> : null}
        {thread.isOutdated ? <Text class="shrink-0 text-2xs font-medium text-muted-foreground">Outdated</Text> : null}
        {expanded() ? null : <Text class="shrink-0 text-2xs text-muted-foreground">{`· ${event.actor?.login ?? "ghost"}${replyCount > 0 ? ` · ${replyCount.toLocaleString("en-US")} ${replyCount === 1 ? "reply" : "replies"}` : ""}`}</Text>}
        <View class="ml-auto"><ChevronTurn open={expanded} degrees={180}><PRIcon name="chevron-down" size={14} /></ChevronTurn></View>
      </View>
      {expanded() ? (
        <>
          <ConversationCard event={event} surface={props.surface} showPath={false} />
          {thread.replies.length > 0 ? (
            <View class="ml-2 flex-col gap-1 border-l border-border-60 pl-3">
              <Each of={thread.replies} key={(reply: TimelineEvent) => reply.id}>
                {(reply) => <ConversationCard event={reply()} surface={props.surface} showPath={false} reply />}
              </Each>
            </View>
          ) : null}
        </>
      ) : null}
      {thread.hasMoreReplies ? <View class="px-2"><PullRequestMoreReplies moreReplies={thread.moreReplies} hasMoreReplies={thread.hasMoreReplies} url={thread.url} /></View> : null}
    </View>
  );
}

function CommitEvent(props: { event: TimelineEvent; surface: Surface; onOpen: (oid: string) => void }) {
  const event = props.event;
  const hover = createHover();
  return (
    <View role="button" accessibilityLabel={`View commit ${event.id}`} onPress={() => props.onOpen(event.id)} class="relative mb-5 w-full rounded-sm pl-12" {...hover.bind}>
      <ActorMarker actors={event.commitAuthors} fallback="git-commit-horizontal" />
      <View class="min-w-0 flex-row items-center gap-2.5 py-1.5">
        <View class="min-w-0 flex-1 flex-col">
          <Text class={`truncate text-xs font-semibold ${hover.hovered() ? "text-primary" : "text-foreground"}`}>{event.body ?? "Untitled commit"}</Text>
          <View class="mt-1 flex-row flex-wrap items-center gap-x-2 gap-y-0.5">
            <Text class="font-mono text-2xs text-muted-foreground">{event.id.slice(0, 7)}</Text>
            <Text class="text-2xs text-muted-foreground">{relativeTime(event.at, props.surface.now())}</Text>
          </View>
        </View>
        {event.additions !== null && event.deletions !== null && (event.additions !== 0 || event.deletions !== 0) ? (
          <View class="ml-auto shrink-0 flex-row items-baseline gap-1">
            <Text class={`font-mono text-2xs ${diffAdditionClass("text-success")}`}>{`+${formatCount(event.additions)}`}</Text>
            <Text class={`font-mono text-2xs ${diffDeletionClass("text-destructive")}`}>{`-${formatCount(event.deletions)}`}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function LifecycleEvent(props: { event: TimelineEvent; surface: Surface; term: string }) {
  const event = props.event;
  const title = props.term.charAt(0).toUpperCase() + props.term.slice(1);
  const presentation = event.kind === "opened" ? { icon: "git-pull-request", label: `${title} opened` } : event.kind === "merged" ? { icon: "git-merge", label: `${title} merged` } : { icon: "git-pull-request-closed", label: `${title} closed` };
  return (
    <View class="relative mb-5 pl-12">
      <IconMarker icon={presentation.icon} />
      <View class="py-1.5">
        <View class="flex-row flex-wrap items-center gap-1.5">
          {event.actor ? <ActorName actor={event.actor} /> : null}
          <Text class="text-xs font-semibold text-foreground">{presentation.label}</Text>
        </View>
        <Text class="mt-0.5 text-2xs text-muted-foreground">{relativeTime(event.at, props.surface.now())}</Text>
      </View>
    </View>
  );
}

function ReviewVerdictEvent(props: { event: TimelineEvent; outcome: ReviewOutcome; stale: boolean; surface: Surface }) {
  const event = props.event;
  const surface = props.surface;
  const tone = () => toneColor(OUTCOME_ICON[props.outcome].tone, scheme());
  const canReact = () => surface.detail().capabilities.reactions === true;
  return (
    <View class="group relative mb-5 pl-12">
      <ActorMarker actors={event.actor ? [event.actor] : []} at="top-6" fallback={OUTCOME_ICON[props.outcome].icon} fallbackTint={tone()} />
      <View class="min-w-0 flex-row flex-wrap items-center gap-2 py-1.5">
        <View class="min-w-0 flex-1 flex-col">
          <View class="flex-row flex-wrap items-center gap-x-1.5 gap-y-1">
            <ActorName actor={event.actor} />
            <Text
              class="text-xs font-medium lowercase"
              style={props.stale ? { opacity: 0.7, color: toneColor({ light: "#71717a", dark: "#a1a1aa" }, scheme()) } : { color: tone() }}
              {...(props.stale ? { tooltip: reviewOutcomeStaleLabel(props.outcome), accessibilityLabel: `${REVIEW_OUTCOME_LABEL[props.outcome]}, before the latest commits` } : {})}
            >{REVIEW_OUTCOME_LABEL[props.outcome]}</Text>
          </View>
          <View class="mt-0.5 flex-row flex-wrap items-center gap-1.5">
            <Text class="text-2xs text-muted-foreground">{relativeTime(event.at, surface.now())}</Text>
            {event.path ? (
              <>
                <Dot />
                <View class="min-w-0 flex-row items-center gap-1"><HIcon name="file" size={12} /><Text class="min-w-0 truncate text-2xs text-muted-foreground">{event.path}</Text></View>
              </>
            ) : null}
          </View>
        </View>
        {event.body && event.comment ? <AddToChatButton event={event} surface={surface} /> : null}
        {canReact() || event.reactions.length > 0 ? (
          <View class="ml-auto"><PullRequestReactionBar reactions={() => event.reactions} canReact={canReact} onToggle={(content, reacted) => surface.actions.setReaction(event.id, content, reacted)} /></View>
        ) : null}
        <OpenOnHostButton url={event.url} onOpen={surface.onOpenHost} />
      </View>
      {event.body ? <TimelineBody body={event.body} markdown={event.markdown} /> : null}
    </View>
  );
}

export function PullRequestTimelineTab(props: {
  detail: () => PullRequestDetailData;
  model: PullRequestDetailModel;
  now: () => number;
  onOpenHost: (url: string) => void;
  /** A commit row was pressed: the Code tab opens scoped to it. */
  onOpenCommit: (oid: string) => void;
  onAddToChat?: Surface["onAddToChat"];
}) {
  const model = props.model;
  const term = () => changeRequestTerm(props.detail().provider);
  const events = () => buildPullRequestTimelineEvents(props.detail(), model.activity());
  const rows = () => groupTimelineConversations(model.timelineOrder() === "newest" ? events() : [...events()].reverse());
  const newest = () => newestCommitAt(model.activity()?.commits ?? []);
  const surface: Surface = { detail: props.detail, actions: model.actions, now: props.now, onOpenHost: props.onOpenHost, ...(props.onAddToChat ? { onAddToChat: props.onAddToChat } : {}) };
  const renderRow = (row: TimelineRow) => {
    if (row.kind === "comments") return <ConversationGroup events={row.events} surface={surface} />;
    const event = row.event;
    if (event.thread !== undefined) return <ReviewThreadEvent event={event} surface={surface} />;
    if (event.kind === "commit") return <CommitEvent event={event} surface={surface} onOpen={props.onOpenCommit} />;
    const outcome = reviewOutcome(event.reviewState);
    if (outcome !== null) return <ReviewVerdictEvent event={event} outcome={outcome} stale={isVerdictStale(event.at, newest())} surface={surface} />;
    return <LifecycleEvent event={event} surface={surface} term={term()} />;
  };
  return (
    <Scroll class="min-h-0 flex-1" accessibilityLabel="Pull request timeline" contentClass="px-4">
      {model.activityError() ? <PullRequestActivityUnavailableState error={model.activityError()} term={term()} onRetry={() => void model.refresh()} compact /> : null}
      {!model.activity() && !model.activityError() ? <PullRequestTimelineGhost /> : null}
      {events().length === 0 ? (
        <View class="items-center justify-center gap-2 py-16"><PRIcon name="git-pull-request" size={20} /><Text class="text-xs text-muted-foreground">No activity yet.</Text></View>
      ) : (
        <View class="relative mx-auto w-full max-w-3xl flex-col">
          <View class="absolute w-px bg-border-50" style={{ left: 15, top: 24, bottom: 40 }} />
          <View class="h-5" />
          <Each of={rows()} key={timelineRowKey}>{(row) => renderRow(row())}</Each>
          {model.activity()?.truncated ? <View class="py-2 pl-12"><Text class="text-xs text-muted-foreground">Older comments are not shown. Open the pull request on the host to read them.</Text></View> : null}
          <View class="h-5" />
        </View>
      )}
      <PullRequestComposer detail={props.detail} actions={model.actions} />
    </Scroll>
  );
}
