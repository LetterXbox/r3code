import { Clipboard, effect, signal, Text, untracked, View, windowSize } from "nsh";
import { FadeScroll, fadeGradientStyle, resolveFadeColor } from "../../FadeScroll";
import { tokenAlpha } from "../../composer/tokenColor";
import { noteUserInput } from "../../userActivity";
import { findRevealsRow } from "../threadFindState";
import type { ScrollRef } from "nsh";
import { showToast } from "../../toast/toastState";
import { FILESYSTEM_WRITE_SCOPE, scopeAllows } from "../../../backend/sessionScopes";
import { Input, Menu, MenuItem } from "nsh/base";
import { ShimmerText } from "./Shimmer";
import { t3McpDefinition } from "./t3McpTools";
import { itemDetailOf, loadItemDetail, needsItemDetail } from "./itemDetail";
import { ItemInspector } from "./ItemInspector";
import { turnItemHasDetail, type TurnItem } from "./turnItemDetail";
import { TimelineRowTimestamp } from "./TimelineRowParts";
import { createHover } from "../../hoverReveal";
import { chatWidthClass } from "../layout";
import { ChatMarkdown } from "../markdown/ChatMarkdown";
import { HighlightedCodeLines } from "../markdown/HighlightedCodeLines";
import { IconSlot, TimelineIcon } from "../markdown/TimelineIcon";
import { ToolActivityIconView } from "./ToolActivityIcon";
import { Icon } from "../../Icons";
import { trackOpenChange, useOverlayOpen } from "../../rightPanel/nativeOcclusion";
import { currentWorkspace, openSurfaceAction } from "../../rightPanel/panelState";
import { openToolCallDiff } from "../../diff/openDiff";
import { backendUrl, loadDeferredWork, openThread, openThreadById, requestBackend, respondToApproval, settingValue, threadApprovals, threadById, threadSubagentRecordsFor } from "../../../store";
import { ApprovalPanel, type ApprovalDisplay } from "../ApprovalPanel";
import { SubagentRow } from "./SubagentRows";
import { notifiedSubagent, subagentFromRecord, subagentNotificationEvent } from "./subagents";
import { asTimestampFormat, formatShortTimestamp } from "../timestampFormat";
import { buildProposedPlanMarkdownFilename, canCollapsePlan, collapsedPlanPreview, downloadPlanMarkdown, normalizePlanMarkdownForExport, savePlanToWorkspace, validatePlanSavePath } from "./planActions";
import { dismissThreadErrorBannerForSession, getThreadErrorBannerKey, getThreadErrorBannerMessage, shouldShowThreadErrorBanner } from "./threadError";
import { liveThoughtLine, liveWorkLabel, type LiveRow } from "./liveTurn";
import { ChevronTurn, loopStyle } from "../../motion/Motion";
import { skeletonPulse } from "../../motion/motionTokens";
import {
  diffStat, formatWorkingTimer, itemActive, itemFailed, itemUsesDestructiveLabel, proposedPlanBody, proposedPlanTitle, splitCommandDetail,
  splitFileChange, summarizeWorkGroup, workItemIconName, workRowLabel, type WorkItem,
} from "./workLog";

const lane = () => `mx-auto w-full ${chatWidthClass()}`;

/** commandLabel.ts withVisibleControlCharacters: control characters as their Control Pictures (U+2400 block), DEL as ␡. */
export function withVisibleControlCharacters(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, (character) => (character === "\u007f" ? "\u2421" : String.fromCharCode(0x2400 + character.charCodeAt(0))));
}

/** ShellCommandBlock: the command, monospace, control characters made visible. */
function ShellCommandBlock(props: { command: string }) {
  return (
    <View selectable>
      <HighlightedCodeLines code={() => `$ ${withVisibleControlCharacters(props.command)}`} language={() => "bash"} />
    </View>
  );
}

function DiffBody(props: { diff: string }) {
  const lines = () => props.diff.split("\n").slice(0, 400);
  return (
    <View selectable>
      <Each of={lines()} key="index">
        {(line) => (
          <Text
            class={
              line().startsWith("+") && !line().startsWith("+++")
                ? "font-mono text-2xs leading-relaxed text-success-foreground"
                : line().startsWith("-") && !line().startsWith("---")
                  ? "font-mono text-2xs leading-relaxed text-error-foreground"
                  : "font-mono text-2xs leading-relaxed text-secondary-label"
            }
          >
            {line() === "" ? " " : line()}
          </Text>
        )}
      </Each>
    </View>
  );
}

function hasBody(item: WorkItem) {
  return item.detail.trim().length > 0 || (item.item !== undefined && turnItemHasDetail(item.item));
}

/** threadReadTargetId: a t3_thread_read call names the thread it read (input.threadId). */
export function threadReadTargetId(item: WorkItem): string | null {
  const raw = item.item as Record<string, unknown> | undefined;
  if (!raw || raw.type !== "dynamic_tool") return null;
  if (t3McpDefinition(typeof raw.toolName === "string" ? raw.toolName : null)?.summaryAction !== "thread-read") return null;
  const input = raw.input as Record<string, unknown> | null | undefined;
  const threadId = input && typeof input === "object" ? input.threadId : null;
  return typeof threadId === "string" && threadId.trim() ? threadId.trim() : null;
}

/** threadReadLabel: "Read thread “<title>”" when the label reads "... a T3 thread" and the thread is known. */
export function threadReadLabel(label: string, target: { threadId: string; title: string } | null): { threadId: string; title: string; prefix: string } | null {
  const object = " a T3 thread";
  if (!target || !label.endsWith(object)) return null;
  return { ...target, prefix: `${label.slice(0, -object.length)} thread` };
}

/** WorkLogDetails: an open tool body keeps following its live output while the reader is at its bottom (a 4pt edge). */
/** resolveWorkGroupScrollIndex: where an expanded work group's own scroll was left, per group, for when it is drawn again. */
const groupScrollMemory = new Map<string, number>();
export function rememberedGroupScroll(key: string): number | undefined { return groupScrollMemory.get(key); }

export function FollowScroll(props: { class: string; live: () => boolean; children: any; style?: Record<string, unknown>; /** Remembers and restores the scroll offset under this key. */ memoryKey?: string; accessibilityLabel?: string; /** Test seam. */ onFollow?: (y: number) => void }) {
  let ref: ScrollRef | null = null;
  let viewport = 0;
  let offset = 0;
  let atBottom = props.memoryKey === undefined || !groupScrollMemory.has(props.memoryKey);
  let restored = false;
  const follow = (height: number) => {
    if (!restored && props.memoryKey !== undefined) {
      restored = true;
      const saved = groupScrollMemory.get(props.memoryKey);
      if (saved !== undefined) { ref?.scrollTo({ y: saved, animated: false }); return; }
    }
    if (!props.live() || !atBottom || viewport <= 0 || height <= viewport) return;
    const y = height - viewport;
    ref?.scrollTo({ y, animated: false });
    props.onFollow?.(y);
  };
  return (
    <FadeScroll
      surface="background"
      ref={(node: ScrollRef | null) => { ref = node; }}
      class={props.class}
      accessibilityLabel={props.accessibilityLabel}
      onLayout={(event) => { viewport = event.bounds.size.height; }}
      onContentLayout={(size) => follow(size.height)}
      style={props.style as never}
      onScroll={(event) => { noteUserInput(); offset = event.offset.y; viewport = event.size.height; atBottom = event.contentSize.height - offset - viewport <= 4; if (props.memoryKey !== undefined) groupScrollMemory.set(props.memoryKey, offset); }}
    >
      {props.children}
    </FadeScroll>
  );
}

/** One tool call inside an open group: icon, label, diff stat, and a body that opens on press. */
/** TimelineWorkGroupRows / LiveWorkEntryRow: an approval_request row whose request is still pending draws as the pending approval itself. */
export function pendingApprovalForItem(item: WorkItem, approvals: readonly ApprovalDisplay[] = threadApprovals()): ApprovalDisplay | null {
  const requestId = (item as { requestId?: unknown }).requestId;
  return item.type === "approval_request" && typeof requestId === "string" ? approvals.find((approval) => approval.id === requestId) ?? null : null;
}

function InlinePendingApproval(props: { approval: () => ApprovalDisplay }) {
  return <ApprovalPanel inline scope={() => JSON.stringify([backendUrl(), openThread()?.id ?? ""])} approvals={() => [props.approval()]} onRespond={respondToApproval} />;
}

export function WorkEntryRow(props: Parameters<typeof WorkEntryRowInner>[0]) {
  const pending = () => pendingApprovalForItem(props.item());
  return pending() ? <InlinePendingApproval approval={() => pending()!} /> : <WorkEntryRowInner {...props} />;
}

function WorkEntryRowInner(props: { item: () => WorkItem; expanded: () => boolean; onToggle: (id: string) => void; /** The thread a "Read thread" label links to; with a title lookup the label names it. */ onOpenThread?: (threadId: string) => void; threadTitle?: (threadId: string) => string | null }) {
  const linkHover = createHover();
  const readLabel = () => {
    const id = threadReadTargetId(props.item());
    const title = id ? (props.threadTitle ? props.threadTitle(id) : threadById(id)?.title ?? null)?.trim() : null;
    return id && title ? threadReadLabel(workRowLabel(props.item()), { threadId: id, title }) : null;
  };
  // An item whose output the environment withheld is fetched when its row opens (V2ItemInspector).
  const fetched = () => (needsItemDetail(props.item()) ? itemDetailOf(props.item()) : undefined);
  effect(() => { if (props.expanded() && needsItemDetail(props.item())) loadItemDetail(props.item()); });
  const item = () => { const base = props.item(); const state = fetched(); return state?.state === "ready" ? { ...base, detail: state.detail } : base; };
  const stat = () => (item().type === "file_change" ? diffStat(splitFileChange(item().detail).diff) : null);
  const hover = createHover();
  return (
    <View class="min-w-0">
      <View
        class="min-h-6 flex-row items-center gap-2 rounded-md"
        onPress={() => props.onToggle(item().id)}
        disabled={!hasBody(item())}
        accessibilityLabel={`${props.expanded() ? "Collapse" : "Expand"} ${item().title}${itemFailed(item()) ? ", tool call failed" : ""}`}
        accessibilityState={{ expanded: props.expanded() }}
        role="button"
        {...hover.bind}
        {...hover.trackFocus}
      >
        {item().toolIcon && !itemFailed(item()) ? <ToolActivityIconView icon={() => item().toolIcon} fallback={() => workItemIconName(item())} muted /> : <IconSlot name={workItemIconName(item())} size={14} {...(itemFailed(item()) ? { tint: tokenAlpha("error-foreground", 0.4) } : {})} />}
        {itemUsesDestructiveLabel(item()) ? (
          <Text class="min-w-0 flex-1 truncate text-sm text-error-foreground">{workRowLabel(item())}</Text>
        ) : (
          <View class="min-w-0 flex-1 flex-row">
            {readLabel() ? (
              <View class="min-w-0 flex-row">
                <Text class="shrink-0 text-sm text-foreground">{`${readLabel()!.prefix} “`}</Text>
                <View class="min-w-0 shrink" role="link" accessibilityLabel={`Open ${readLabel()!.title}`} onPress={() => (props.onOpenThread ?? openThreadById)(readLabel()!.threadId)} {...linkHover.bind}>
                  <Text class={`truncate text-sm text-foreground ${linkHover.hovered() ? "underline" : ""}`}>{readLabel()!.title}</Text>
                </View>
                <Text class="shrink-0 text-sm text-foreground">{"”"}</Text>
              </View>
            ) : (
                          <ShimmerText text={() => (item().type === "reasoning" && props.expanded() ? (itemActive(item()) ? "Thinking" : "Thought") : workRowLabel(item()))} active={() => itemActive(item())} class="text-sm" />
            )}
          </View>
        )}
        {stat() ? (
          <View class="flex-row gap-1.5">
            <Text class="text-2xs tabular-nums text-success-foreground">{`+${stat()?.added ?? 0}`}</Text>
            <Text class="text-2xs tabular-nums text-error-foreground">{`-${stat()?.removed ?? 0}`}</Text>
          </View>
        ) : null}
        {itemFailed(item()) ? <TimelineIcon name="x" size={12} /> : null}
        <TimelineRowTimestamp createdAt={() => item().startedAt ?? item().order} hovered={hover.hovered} />
        {/* TimelineWorkEntryRow: the trailing chevron (kept in place, invisible, when the row has no body). */}
        <View class={`size-4 shrink-0 items-center justify-center ${hasBody(item()) ? "" : "opacity-0"}`}>
          <ChevronTurn open={props.expanded} durationMs={200}><Icon name="chevron-right" size={12} /></ChevronTurn>
        </View>
      </View>
      {props.expanded() && item().item && item().type !== "reasoning" ? (
        <View class="ms-6 pb-1 pt-0.5">
          <FollowScroll class="max-h-64" live={() => itemActive(item())}>
            <ItemInspector
              item={item().item!}
              fetched={fetched()?.state === "ready" ? (fetched() as { item?: TurnItem }).item ?? null : null}
              fetchState={fetched()?.state ?? null}
              fetchError={fetched()?.state === "error" ? (fetched() as { message: string }).message : null}
              needsFetch={needsItemDetail(props.item())}
              workspaceRoot={currentWorkspace()?.cwd ?? null}
              onOpenToolDiff={(target) => openToolCallDiff(target.threadId, target)}
              diffSlot={item().item?.type === "file_change" && typeof item().item?.diffStr === "string" && String(item().item?.diffStr).trim() ? <DiffBody diff={String(item().item?.diffStr)} /> : null}
            />
          </FollowScroll>
        </View>
      ) : null}
      {props.expanded() && !(item().item && item().type !== "reasoning") && fetched() && fetched()?.state !== "ready" ? (
        <View class="ms-6 pb-1 pt-0.5">
          <Text class="text-2xs text-muted-foreground">
            {fetched()?.state === "pending" ? "Loading output\u2026" : fetched()?.state === "unavailable" ? "Output is no longer available." : (fetched() as { message: string }).message}
          </Text>
        </View>
      ) : null}
      {props.expanded() && hasBody(item()) && !(item().item && item().type !== "reasoning") ? (
        <View class="ms-6 pb-1 pt-0.5">
          <FadeScroll surface="background" class="max-h-64">
            {item().type === "command_execution" ? (
              <View class="gap-1">
                <ShellCommandBlock command={splitCommandDetail(item().detail).command} />
                {splitCommandDetail(item().detail).output ? (
                  <View selectable>
                    <Text class="font-mono text-2xs leading-relaxed text-secondary-label">{splitCommandDetail(item().detail).output}</Text>
                  </View>
                ) : null}
              </View>
            ) : item().type === "file_change" ? (
              <DiffBody diff={splitFileChange(item().detail).diff || splitFileChange(item().detail).fileName} />
            ) : item().type === "reasoning" ? (
              <ChatMarkdown text={() => item().detail} class="text-muted-foreground" />
            ) : (
              <View selectable>
                <Text class="font-mono text-2xs leading-relaxed text-secondary-label">{item().detail}</Text>
              </View>
            )}
          </FadeScroll>
        </View>
      ) : null}
    </View>
  );
}

/** WorkLogLine: a 24px icon cell and a label, `min-h-6 gap-1.5 text-sm leading-relaxed`. */
function LiveLine(props: { icon: string; wrap?: boolean; children: any }) {
  return (
    <View class={`min-h-6 min-w-0 flex-row gap-1.5 ${props.wrap ? "items-start" : "items-center"}`}>
      <View class="size-6 shrink-0 items-center justify-center">
        <TimelineIcon name={props.icon} size={16} />
      </View>
      <View class="min-w-0 flex-1">{props.children}</View>
    </View>
  );
}

/** ThinkingTimelineRow: the brain mark and a shimmering "Thinking" while the turn has no activity row. */
export function ThinkingRow(props: { /** Zen's live answer preview, shown in place of "Thinking". */ label?: () => string | null }) {
  return (
    <View class={`${lane()} px-0.5 pt-0.5 pb-1.5`} accessibilityLabel="Thinking">
      <LiveLine icon="brain">
        <View class="flex-row">
          <ShimmerText text={() => props.label?.() ?? "Thinking"} active={() => true} class="text-sm" />
        </View>
      </LiveLine>
    </View>
  );
}

/**
 * LiveWorkEntryTimelineRow: the live turn's tail. The latest reasoning shows above as wrapped muted text
 * (liveThoughtLine, four lines at most), then one line for the running tool in the present tense
 * ("Running cat", the program name), which turns past tense once it finishes. Press opens the whole group.
 */
export function LiveWorkRow(props: Parameters<typeof LiveWorkRowInner>[0]) {
  const pending = () => pendingApprovalForItem(props.row().entry);
  return pending() ? <InlinePendingApproval approval={() => pending()!} /> : <LiveWorkRowInner {...props} />;
}

function LiveWorkRowInner(props: { row: () => LiveRow; expandedActivity: () => Record<string, boolean>; onToggle: (id: string) => void }) {
  const row = props.row;
  const expanded = () => Boolean(props.expandedActivity()[row().groupId]);
  const thoughtLine = () => {
    const thought = row().thought;
    return thought && !expanded() ? liveThoughtLine(thought.detail) : "";
  };
  const thoughtIsStatus = () => thoughtLine() !== "" && row().entry === row().thought;
  const label = () => {
    if (thoughtIsStatus()) return row().active ? "Thinking" : "Thought";
    const entry = row().entry;
    return liveWorkLabel(entry, row().active, entry.type === "command_execution" ? splitCommandDetail(entry.detail).command : "");
  };
  return (
    <View class={`${lane()} px-0.5 py-0.5`}>
      <View
        class="rounded-md"
        onPress={() => props.onToggle(row().groupId)}
        accessibilityLabel={`${expanded() ? "Collapse" : "Expand"} live activity`}
        accessibilityState={{ expanded: expanded() }}
        role="button"
      >
        {thoughtLine() ? (
          <LiveLine icon="brain" wrap>
            <Text class="line-clamp-4 text-sm leading-relaxed text-muted-foreground">{thoughtLine()}</Text>
          </LiveLine>
        ) : null}
        <LiveLine icon={workItemIconName(row().entry)}>
          <View class="flex-row">
            <ShimmerText text={label} active={() => row().active} class="text-sm" />
          </View>
        </LiveLine>
      </View>
      {expanded() ? (
        <FollowScroll accessibilityLabel="Tool calls" class="mt-0.5" style={{ maxHeight: Math.min(288, Math.round(windowSize().height * 0.5)) }} live={() => row().active} memoryKey={row().groupId}>
          <View class="gap-0.5 px-1">
            <Each of={row().items} key={(item) => item.id}>
              {(item) => <WorkEntryRow item={item} expanded={() => Boolean(props.expandedActivity()[item().id])} onToggle={props.onToggle} />}
            </Each>
          </View>
        </FollowScroll>
      ) : null}
    </View>
  );
}

/** workEntryIconName for a notification: the T3 mark for a system notice (a restart), else by source. */
function noticeIcon(item: WorkItem): string | null {
  if (item.notice?.outcome === "failed") return "circle-alert";
  switch (item.notice?.source) {
    case "subagent": case "delegated_task": return "bot";
    case "command": return "terminal";
    case "monitor": return "eye";
    case "background_task": return "zap";
    default: return null;
  }
}

/** A notification turn item (TimelineWorkEntryRow): the source's mark, its summary and a chevron at the lane's right edge; press shows the detail. */
/** notificationChildThreadId: a subagent or delegated-task notification names the child thread it came from. */
export function noticeChildThreadId(item: WorkItem): string | undefined {
  const source = (item.item as Record<string, unknown> | undefined)?.source as Record<string, unknown> | undefined;
  if (!source || (source.kind !== "subagent" && source.kind !== "delegated_task")) return undefined;
  return typeof source.childThreadId === "string" && source.childThreadId ? source.childThreadId : undefined;
}

/** SimpleWorkEntryRow: a subagent or delegated-task notification whose child is known draws as that child's row
 * (SubagentNotificationLink) with the outcome ("Finished", "Failed", "Stopped", "Updated") and its time; otherwise the log row. */
export function NoticeRow(props: { item: () => WorkItem; expanded: () => boolean; onToggle: (id: string) => void; onOpenThread?: (threadId: string) => void; parentThreadId?: () => string | null }) {
  const linked = () => {
    const item = props.item();
    const raw = item.item as Record<string, unknown> | undefined;
    const childThreadId = noticeChildThreadId(item);
    const parentThreadId = props.parentThreadId?.() ?? (typeof raw?.threadId === "string" ? raw.threadId : null);
    if (!raw || !childThreadId || !parentThreadId) return null;
    const source = raw.source as Record<string, unknown> | undefined;
    const taskIds = source?.kind === "delegated_task" && Array.isArray(source.taskIds) ? source.taskIds : undefined;
    const record = notifiedSubagent(threadSubagentRecordsFor(parentThreadId), childThreadId, taskIds);
    const agent = record ? subagentFromRecord(record) : undefined;
    if (!agent) return null;
    const notifiedAt = typeof raw.createdAt === "string" ? Date.parse(raw.createdAt) : item.order ?? NaN;
    const event = subagentNotificationEvent(agent, typeof raw.outcome === "string" ? raw.outcome : "unknown", notifiedAt, formatShortTimestamp(notifiedAt, asTimestampFormat(settingValue("timestampFormat"))));
    return { agent: { ...agent, childThreadId }, event };
  };
  return (
    <View>
      {linked() ? (
        <View class={`${lane()} py-0.5`}>
          <SubagentRow agent={() => linked()!.agent} event={() => linked()?.event} now={() => Date.now()} onOpen={props.onOpenThread} />
        </View>
      ) : <NoticeLogRow {...props} />}
    </View>
  );
}

function NoticeLogRow(props: { item: () => WorkItem; expanded: () => boolean; onToggle: (id: string) => void; /** "Open subagent": opens the notification's child thread. */ onOpenThread?: (threadId: string) => void }) {
  const childThreadId = () => noticeChildThreadId(props.item());
  const openHover = createHover();
  const detail = () => props.item().detail.trim();
  const body = () => (detail() === props.item().title.trim() ? "" : detail());
  return (
    <View class={`${lane()} py-0.5`}>
      <View
        class="group min-h-6 flex-row items-center gap-1.5 rounded-md"
        onPress={() => props.onToggle(props.item().id)}
        disabled={body() === ""}
        accessibilityLabel={props.item().title}
        accessibilityState={{ expanded: props.expanded() }}
        role="button"
      >
        <View class="size-6 shrink-0 items-center justify-center">
          {noticeIcon(props.item()) === null
            ? <Text class="text-xs font-bold text-icon-muted">T3</Text>
            : <TimelineIcon name={noticeIcon(props.item()) ?? "zap"} size={16} />}
        </View>
        <Text class="min-w-0 flex-1 truncate text-sm leading-relaxed text-foreground">{props.item().title}</Text>
        {childThreadId() && props.onOpenThread ? (
          <View class="shrink-0 rounded-sm" onPress={() => props.onOpenThread?.(childThreadId()!)} accessibilityLabel="Open subagent thread" role="button" {...openHover.bind}>
            <Text class={`text-sm font-medium text-foreground ${openHover.hovered() ? "underline" : ""}`}>Open subagent</Text>
          </View>
        ) : null}
        {body() !== "" ? <ChevronTurn open={props.expanded} durationMs={200}><Icon name="chevron-right" size={14} /></ChevronTurn> : null}
      </View>
      {props.expanded() && body() !== "" ? (
        <View class="ms-7 pb-1 pt-0.5" selectable>
          <Text class="text-xs leading-relaxed text-muted-foreground">{body()}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** WorkGroupSection: "Ran 2 commands and changed 1 file" folded over its tool calls. */
export function WorkGroupRow(props: {
  id: string;
  items: () => WorkItem[];
  active: () => boolean;
  expandedActivity: () => Record<string, boolean>;
  onToggle: (id: string) => void;
  /** Reports the lane's horizontal position for layout checks. */
  onLaneLayout?: (left: number, width: number) => void;
}) {
  const singleCommand = () => props.items().length === 1 && !props.active() && props.items()[0]?.type === "command_execution";
  const item = () => props.items()[0]!;
  // MessagesTimeline.logic: a group holding a pending approval is never collapsed, so the approval shows at its position.
  const open = () => Boolean(props.expandedActivity()[props.id]) || props.items().some((item) => pendingApprovalForItem(item) !== null);
  const summary = () => summarizeWorkGroup(props.items());
  const last = () => props.items()[props.items().length - 1];
  const headline = () => {
    const current = last();
    return props.active() && current ? liveWorkLabel(current, true, current.type === "command_execution" ? splitCommandDetail(current.detail).command : "") : summary().summary;
  };
  const hover = createHover();
  return (
    <View class={`${lane()} py-1`} onLayout={props.onLaneLayout ? (event) => props.onLaneLayout?.(event.bounds.origin.x, event.bounds.size.width) : undefined}>
      {singleCommand() ? <WorkEntryRow item={item} expanded={() => Boolean(props.expandedActivity()[item().id])} onToggle={props.onToggle} /> : <>
      <View
        class="min-h-6 flex-row items-center gap-1.5 rounded-md px-1"
        onPress={() => props.onToggle(props.id)}
        accessibilityLabel={`${open() ? "Collapse" : "Expand"} ${summary().summary}${summary().hasFailure ? ", tool call failed" : ""}`}
        accessibilityState={{ expanded: open() }}
        role="button"
        {...hover.bind}
        {...hover.trackFocus}
      >
        <IconSlot name={props.active() && last() ? workItemIconName(last()) : summary().icon} size={14} />
        <ShimmerText text={headline} active={() => props.active() && !summary().hasFailure} class="text-sm" />
        <Icon name={open() ? "chevron-down" : "chevron-right"} size={14} />
        <View class="flex-1 flex-row justify-end">
          <TimelineRowTimestamp createdAt={() => props.items()[0]?.order} hovered={hover.hovered} />
        </View>
      </View>
      {open() ? (
        // TimelineWorkGroupRows: an open group is capped at min(18rem, 50% of the window) and scrolls inside, following
        // appended calls while at its end and keeping where it was left when it is drawn again.
        <FollowScroll accessibilityLabel="Tool calls" class="mt-0.5" style={{ maxHeight: Math.min(288, Math.round(windowSize().height * 0.5)) }} live={props.active} memoryKey={props.id}>
          <View class="gap-0.5 px-1">
            <Each of={props.items()} key={(item) => item.id}>
              {(item) => <WorkEntryRow item={item} expanded={() => Boolean(props.expandedActivity()[item().id])} onToggle={props.onToggle} />}
            </Each>
          </View>
        </FollowScroll>
      ) : null}
      </>}
    </View>
  );
}

/** TurnFoldTimelineRow: `border-b border-border/60 pb-2 pt-1`, a muted text-sm "Worked for 13s" with a chevron, opening the turn's work in place. */
/**
 * MessagesTimeline useDeferredWorkLoading: an open fold holding collapsed work loads it (one read per anchor); while
 * anchors remain it shows WorkHistorySkeleton, a failed read appends "Couldn't load work. Click to retry." to the label
 * and a press retries instead of toggling.
 */
function useDeferredWorkLoading(props: { anchors?: () => string[] | undefined; expanded: () => boolean; onToggle: () => void }) {
  const failed = signal(false);
  const anchors = () => props.anchors?.() ?? [];
  const load = () => {
    const threadId = untracked(() => openThread()?.id);
    const ids = untracked(anchors);
    if (!threadId || ids.length === 0) return;
    void Promise.all(ids.map((id) => loadDeferredWork(threadId, id))).then((results) => failed.set(results.some((result) => result === "error")));
  };
  effect(() => {
    if (props.expanded() && anchors().join("\n")) load();
  });
  const error = () => (anchors().length > 0 && failed() ? "Couldn't load work. Click to retry." : null);
  const loading = () => props.expanded() && anchors().length > 0 && !failed();
  const toggle = () => {
    const retry = error() !== null && props.expanded();
    failed.set(false);
    if (retry) load();
    else props.onToggle();
  };
  return { loading, error, toggle };
}

/** WorkHistorySkeleton: three icon-and-pill rows (`space-y-2 px-1 pb-1 pt-3`), "Loading work history". */
export function WorkHistorySkeleton() {
  return (
    <View class="gap-2 px-1 pb-1 pt-3" accessibilityLabel="Loading work history">
      {["w-2/5", "w-3/5", "w-1/3"].map((width) => (
        <View class="flex-row items-center gap-2">
          <View class="size-3 shrink-0 rounded-sm bg-muted" style={loopStyle(skeletonPulse)} />
          <View class={`h-2.5 ${width} rounded-full bg-muted`} style={loopStyle(skeletonPulse)} />
        </View>
      ))}
    </View>
  );
}

export function TurnFoldRow(props: { label: () => string; expanded: () => boolean; onToggle: () => void; /** The fold's start time, shown at the right edge on hover (TimelineRowTimestamp). */ createdAt?: () => number | undefined; deferredWorkItemIds?: () => string[] | undefined }) {
  const hover = createHover();
  const work = useDeferredWorkLoading({ anchors: props.deferredWorkItemIds, expanded: props.expanded, onToggle: props.onToggle });
  return (
    <View class={`${lane()} pb-1.5`}>
      <View class="border-b border-border-60 pb-2 pt-1" {...hover.bind}>
        <View class="flex-row items-center gap-1">
          <View
            class="flex-row items-center gap-1 rounded-md px-1"
            onPress={work.toggle}
            accessibilityLabel={props.label()}
            accessibilityState={{ expanded: props.expanded(), busy: work.loading() }}
            role="button"
            {...hover.trackFocus}
          >
            <Text class={`text-sm leading-relaxed tabular-nums transition-colors duration-150 ease-in-out ${hover.hovered() ? "text-foreground" : "text-muted-foreground"}`}>{props.label()}{work.error() ? ` · ${work.error()}` : ""}</Text>
            <Icon name={props.expanded() ? "chevron-down" : "chevron-right"} size={14} />
          </View>
          {props.createdAt ? <View class="ms-auto"><TimelineRowTimestamp createdAt={props.createdAt} hovered={hover.hovered} /></View> : null}
        </View>
        {work.loading() ? <WorkHistorySkeleton /> : null}
      </View>
    </View>
  );
}

/** AttemptFoldTimelineRow: a bordered muted button, chevron, the label and "Cut off by a steer". */
export function AttemptFoldRow(props: { label: () => string; expanded: () => boolean; onToggle: () => void; deferredWorkItemIds?: () => string[] | undefined }) {
  const hover = createHover();
  const work = useDeferredWorkLoading({ anchors: props.deferredWorkItemIds, expanded: props.expanded, onToggle: props.onToggle });
  return (
    <View class={`${lane()} pb-1.5`}>
      <View
        class={`flex-row items-center gap-2 rounded-md border border-border-60 px-2.5 py-2 ${hover.hovered() ? "bg-muted-30" : "bg-muted-10"}`}
        onPress={work.toggle}
        accessibilityLabel={props.label()}
        accessibilityState={{ expanded: props.expanded(), busy: work.loading() }}
        role="button"
        {...hover.bind}
        {...hover.trackFocus}
      >
        <Icon name={props.expanded() ? "chevron-down" : "chevron-right"} size={14} />
        <Text class="text-xs font-medium" style={{ color: tokenAlpha("foreground", 0.8) }}>{props.label()}{work.error() ? ` · ${work.error()}` : ""}</Text>
        <Text class="text-2xs text-muted-foreground">Cut off by a steer</Text>
      </View>
      {work.loading() ? <WorkHistorySkeleton /> : null}
    </View>
  );
}

/** WorkingTimelineRow: `border-b border-border/60 pb-2 pt-1`, a muted h-6 text-sm line "Working for 12s" counted from the run's start. No shimmer: the web app sweeps it only while compacting or preparing a worktree. */
export function WorkingRow(props: { since: () => number | null; compacting?: () => boolean; preparing?: () => boolean; /** The "Background setup" chip at the row's right edge. */ trailing?: () => any }) {
  const now = signal(Date.now());
  const fallbackStart = Date.now();
  effect(() => {
    const timer = setInterval(() => now.set(Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const elapsed = () => now() - (props.since() ?? fallbackStart);
  // The web sweeps the label only while compacting or preparing a worktree.
  const label = () => (props.preparing?.() ? "Setting up worktree\u2026" : props.compacting?.() ? `Compacting for ${formatWorkingTimer(elapsed())}` : null);
  return (
    <View class={`${lane()} pb-1.5`}>
      <View class="border-b border-border-60 pb-2 pt-1" accessibilityLabel="Working">
        <View class="h-6 flex-row items-center gap-1.5 px-1">
          {props.compacting?.() && !props.preparing?.() ? <TimelineIcon name="minimize-2" size={12} /> : null}
          {label() === null ? (
            <Text class="text-sm leading-relaxed text-muted-foreground tabular-nums">{props.since() === null ? "Working..." : `Working for ${formatWorkingTimer(elapsed())}`}</Text>
          ) : (
            <ShimmerText text={() => label() ?? ""} active={() => true} class="text-sm tabular-nums" />
          )}
          {props.trailing?.() ? <View class="ml-auto min-w-0 shrink-0">{props.trailing?.()}</View> : null}
        </View>
      </View>
    </View>
  );
}

/** TimelineSystemDivider: a rule, a centred label with optional detail, a rule. */
export function SystemDivider(props: { label: string; detail?: string; tone?: "neutral" | "danger"; compaction?: boolean; active?: boolean; /** A lucide mark before the label (TimelineSystemDivider's `icon`). */ icon?: string; /** Makes the label a button (TimelineSystemDivider's `onAction`). */ actionLabel?: string; onAction?: () => void; /** The detail wraps instead of truncating (TimelineSystemDivider's `wrapDetail`). */ wrapDetail?: boolean }) {
  const danger = () => props.tone === "danger";
  return (
    <View class={`${lane()} flex-row items-center gap-2 py-2`}>
      <View class="h-px flex-1 bg-border-60" />
      <View
        class={props.onAction ? "min-w-0 flex-row items-center gap-1.5 rounded-full border border-border-60 bg-background px-2.5 py-1 hover:bg-accent" : "min-w-0 flex-row items-center gap-1.5 rounded-full px-2 py-1"}
        onPress={props.onAction}
        accessibilityLabel={props.onAction ? props.actionLabel : undefined}
        tooltip={props.onAction ? props.actionLabel : undefined}
        role={props.onAction ? "button" : undefined}
      >
        {props.compaction ? <TimelineIcon name="minimize-2" size={12} /> : props.icon ? <TimelineIcon name={props.icon} size={12} /> : null}
        {props.active ? (
          <ShimmerText text={() => props.label} active={() => true} class="text-2xs font-medium" />
        ) : (
          <Text class={danger() ? "text-2xs font-medium text-destructive" : "text-2xs font-medium text-muted-foreground"}>{props.label}</Text>
        )}
        {props.detail ? <Text class={`${props.wrapDetail ? "max-w-80" : "max-w-80 truncate"} text-2xs ${danger() ? "text-destructive" : "text-muted-foreground"} opacity-70`}>{`· ${props.detail}`}</Text> : null}
      </View>
      <View class="h-px flex-1 bg-border-60" />
    </View>
  );
}

/** V2LifecycleRow thread_created: a work-log row (T3 mark, "Created thread · <title>", an "Open chat" inline button), or,
 * repeated under its run's reply (resourceSummary), a bordered card with the title and an outline "Open chat" button. */
export function CreatedThreadRow(props: { title: () => string | null; resourceSummary: () => boolean; onOpen: () => void }) {
  const openHover = createHover();
  const name = () => props.title() ?? "created thread";
  return (
    <View class={`${lane()} py-0.5`}>
      {props.resourceSummary() ? (
        <View class="min-w-0 flex-row items-center gap-3 rounded-lg border border-border-60 p-3">
          <View class="size-9 shrink-0 items-center justify-center rounded-lg bg-muted-50">
            <Icon name="message-square" size={16} />
          </View>
          <Text class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{props.title() ?? "Created thread"}</Text>
          <View class="h-6 shrink-0 flex-row items-center rounded-md border border-border px-2 hover:bg-accent" onPress={props.onOpen} accessibilityLabel={`Open ${name()}`} role="button">
            <Text class="text-xs font-medium text-foreground">Open chat</Text>
          </View>
        </View>
      ) : (
        <View class="min-h-6 flex-row items-center gap-1.5 rounded-md">
          <View class="size-6 shrink-0 items-center justify-center"><TimelineIcon name="t3-code" size={16} /></View>
          <Text class="min-w-0 flex-1 truncate text-sm leading-relaxed text-foreground">{`Created thread${props.title() ? ` \u00b7 ${props.title()}` : ""}`}</Text>
          <View class="shrink-0 rounded-sm" onPress={props.onOpen} accessibilityLabel={`Open ${name()}`} role="button" {...openHover.bind}>
            <Text class={`text-sm font-medium text-foreground ${openHover.hovered() ? "underline" : ""}`}>Open chat</Text>
          </View>
        </View>
      )}
    </View>
  );
}

/** ProposedPlanCard: a Plan badge, the plan's title, an actions menu, and the plan clipped behind a fade past 900 characters or 20 lines. */
export function ProposedPlanCard(props: {
  item: () => WorkItem;
  /** The plan's timeline row: the active find match in a collapsed plan expands it (ProposedPlanCard findReveal). */
  findRowId?: () => string;
  /** Where Save to workspace writes; the open thread's folder by default. */
  workspaceRoot?: () => string | null;
  request?: (method: string, payload: unknown) => Promise<unknown>;
  download?: (filename: string, markdown: string) => Promise<string>;
}) {
  const expanded = signal(false);
  const markdown = () => props.item().detail;
  const title = () => proposedPlanTitle(markdown()) ?? "Proposed plan";
  const body = () => proposedPlanBody(markdown());
  const canCollapse = () => canCollapsePlan(markdown());
  const collapsed = () => canCollapse() && !expanded();
  effect(() => { if (canCollapse() && findRevealsRow(props.findRowId?.(), markdown())) untracked(() => expanded.set(true)); });
  const copied = signal(false);
  const status = signal<{ tone: "ok" | "error"; text: string } | null>(null);
  const saving = signal(false);
  const menuOpen = signal(false);
  useOverlayOpen(menuOpen, "plan actions");
  const saveOpen = signal(false);
  const savePath = signal("");
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  const workspaceRoot = () => (props.workspaceRoot ? props.workspaceRoot() : currentWorkspace()?.cwd ?? null);
  const filename = () => buildProposedPlanMarkdownFilename(markdown());
  const itemClass = "min-h-7 flex-row items-center gap-2 rounded-sm px-2 hover:bg-accent";
  async function copyPlan() {
    try {
      await Clipboard.writeText(normalizePlanMarkdownForExport(markdown()));
      copied.set(true);
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => copied.set(false), 1500);
    } catch (cause) {
      showToast({ type: "error", title: "Could not copy plan", description: cause instanceof Error ? cause.message : "An error occurred while copying." });
    }
  }
  async function download() {
    try {
      const target = await (props.download ?? downloadPlanMarkdown)(filename(), markdown());
      status.set({ tone: "ok", text: `Plan saved to ${target}` });
    } catch (cause) {
      status.set({ tone: "error", text: cause instanceof Error ? cause.message : "Could not download the plan." });
    }
  }
  function openSave() {
    if (!workspaceRoot()) {
      showToast({ type: "error", title: "Workspace path is unavailable", description: "This thread does not have a workspace path to save into." });
      return;
    }
    status.set(null);
    savePath.set(savePath() || filename());
    saveOpen.set(true);
  }
  async function save() {
    const root = workspaceRoot();
    if (!root || saving()) return;
    const checked = validatePlanSavePath(savePath());
    if ("error" in checked) {
      status.set({ tone: "error", text: checked.error });
      return;
    }
    saving.set(true);
    try {
      const saved = await savePlanToWorkspace({ request: props.request ?? requestBackend }, root, checked.path, markdown());
      saveOpen.set(false);
      status.set(null);
      showToast({ type: "success", title: "Plan saved to workspace", description: saved });
    } catch (cause) {
      showToast({ type: "error", title: "Could not save plan", description: cause instanceof Error ? cause.message : "An error occurred while saving." });
    } finally {
      saving.set(false);
    }
  }
  effect(() => () => clearTimeout(copyTimer));
  return (
    <View class={`${lane()} py-1`}>
      <View class="rounded-2xl border border-border-70 bg-card-40 p-5">
        <View class="flex-row items-center justify-between gap-3">
          <View class="min-w-0 flex-1 flex-row items-center gap-2">
            <View class="rounded-md bg-secondary px-1.5 py-0.5">
              <Text class="text-xs font-medium text-secondary-foreground">Plan</Text>
            </View>
            <Text class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title()}</Text>
          </View>
          <Menu
            onOpenChange={trackOpenChange(menuOpen)}
            popupClass="min-w-[180px] rounded-lg border border-border bg-popover-84 p-1"
            placement="bottom"
            align="end"
            trigger={
              <View class="size-6 items-center justify-center rounded-md border border-input hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out" accessibilityLabel="Plan actions" role="button">
                <TimelineIcon name="ellipsis" size={16} />
              </View>
            }
          >
            <MenuItem accessibilityLabel="Copy to clipboard" class={itemClass} onSelect={() => { void copyPlan(); }}>
              <Text class="text-sm text-popover-foreground">{copied() ? "Copied!" : "Copy to clipboard"}</Text>
            </MenuItem>
            <MenuItem accessibilityLabel="Download as markdown" class={itemClass} onSelect={() => { void download(); }}>
              <Text class="text-sm text-popover-foreground">Download as markdown</Text>
            </MenuItem>
            <MenuItem accessibilityLabel="Save to workspace" class={itemClass} disabled={!workspaceRoot() || saving() || !scopeAllows(FILESYSTEM_WRITE_SCOPE)} onSelect={openSave}>
              <Text class="text-sm text-popover-foreground">Save to workspace</Text>
            </MenuItem>
          </Menu>
        </View>
        {saveOpen() ? (
          <View class="mt-3 gap-2 rounded-xl border border-border-60 p-3">
            <Text class="text-sm font-medium text-foreground">Save plan to workspace</Text>
            <Text class="text-xs text-muted-foreground">{`Enter a path relative to ${workspaceRoot() ?? "the workspace"}.`}</Text>
            <Input
              value={savePath()}
              placeholder={filename()}
              accessibilityLabel="Workspace path"
              readonly={saving()}
              onChange={(event) => savePath.set(event.value)}
              class="h-8 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground"
            />
            <View class="flex-row justify-end gap-2">
              <View class="h-7 items-center justify-center rounded-lg border border-input px-2.5 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out" onPress={() => saveOpen.set(false)} disabled={saving()} accessibilityLabel="Cancel save" role="button">
                <Text class="text-sm text-foreground">Cancel</Text>
              </View>
              <View class="h-7 items-center justify-center rounded-lg bg-primary px-2.5 active:scale-[0.97] transition-transform duration-150 ease-in-out" onPress={() => { void save(); }} disabled={saving()} accessibilityLabel="Save plan" role="button">
                <Text class="text-sm text-primary-foreground">{saving() ? "Saving..." : "Save"}</Text>
              </View>
            </View>
          </View>
        ) : null}
        {status() ? (
          <Text class={status()?.tone === "error" ? "mt-2 text-xs text-error-foreground" : "mt-2 text-xs text-muted-foreground"} role="text">{status()?.text}</Text>
        ) : null}
        <View class="mt-4">
          <View class="relative">
            <View
              class={collapsed() ? "max-h-104 overflow-hidden" : ""}
              selectable
            >
              <ChatMarkdown text={() => (collapsed() ? collapsedPlanPreview(markdown(), 10) : body())} findRowId={props.findRowId} class="text-foreground" />
            </View>
            {collapsed() ? <View class="absolute inset-x-0 bottom-0 h-12" style={{ ...fadeGradientStyle("bottom", resolveFadeColor("card-40")), pointerEvents: "none" }} /> : null}
          </View>
          {canCollapse() ? (
            <View class="mt-4 items-center">
              <View
                class="h-8 items-center justify-center rounded-lg border border-input px-3 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
                onPress={() => expanded.update((value) => !value)}
                accessibilityLabel={expanded() ? "Collapse plan" : "Expand plan"}
                role="button"
              >
                <Text class="text-sm text-foreground">{expanded() ? "Collapse plan" : "Expand plan"}</Text>
              </View>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/** ThreadErrorBanner: error surface, alert icon, the message, a dismiss control. */
export function ThreadErrorBanner(props: { error: () => string | null; onDismiss?: () => void }) {
  return props.error() ? (
    <View class="px-4 pt-3" role="alert">
      <View class="mx-auto w-full max-w-[768px] flex-row items-start gap-2 rounded-lg border border-error bg-error-surface px-3 py-2">
        <View class="mt-0.5">
          <TimelineIcon name="circle-alert" size={16} />
        </View>
        <Text class="min-w-0 flex-1 text-sm text-error-foreground">{getThreadErrorBannerMessage(props.error() ?? "")}</Text>
        {props.onDismiss ? (
          <View
            class="size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
            onPress={props.onDismiss}
            accessibilityLabel="Dismiss error"
            role="button"
          >
            <Icon name="x" size={12} />
          </View>
        ) : null}
      </View>
    </View>
  ) : null;
}

const dismissTick = signal(0);

/** The thread's error as a banner; dismissing hides that error for the session, as the web app does. */
export function ThreadErrorLane(props: { threadKey: () => string; error: () => string | null }) {
  const visible = () => {
    dismissTick();
    return shouldShowThreadErrorBanner(props.threadKey(), props.error());
  };
  return (
    <ThreadErrorBanner
      error={() => (visible() ? props.error() : null)}
      onDismiss={() => {
        dismissThreadErrorBannerForSession(getThreadErrorBannerKey(props.threadKey(), props.error()));
        dismissTick.update((value) => value + 1);
      }}
    />
  );
}
