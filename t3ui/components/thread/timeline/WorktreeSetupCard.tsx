// chat/WorktreeSetupCard.tsx and TimelineWorkGroupRows.tsx BackgroundWorktreeSetupChip: the stages of a new worktree's
// setup with their timings, the setup script's last output lines, Details (Branch / Base / Path / Setup), Open terminal
// Work locally (a draft only: cancel setup, then re-send locally, see worktreeWorkLocally.ts) and Cancel (`worktreeSetup.cancel`).
import { MiddleTruncate } from "../../MiddleTruncate";
import { effect, signal, Text, View } from "nsh";
import { Popover } from "nsh/base";
import { requestBackend } from "../../../store";
import { ChevronTurn } from "../../motion/Motion";
import { Icon } from "../../Icons";
import { trackOpenChange, useOverlayOpen } from "../../rightPanel/nativeOcclusion";
import { openTerminalIdAction } from "../../rightPanel/panelState";
import { chatWidthClass } from "../layout";
import { TimelineIcon } from "../markdown/TimelineIcon";
import { ShimmerText } from "./Shimmer";
import { Spinner } from "../../sidebar/Spinner";
import { formatDuration, worktreeSetupHeaderLabel, worktreeSetupStageLabel, type WorktreeSetupSnapshot, type WorktreeSetupStage } from "./worktreeSetup";

const elapsed = (startedAt: string | null, end: number) => {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? formatDuration(Math.max(0, end - start)) : null;
};

/** Elapsed: a finished duration, or a ticking one while setup runs. */
function Elapsed(props: { startedAt: string | null; endedAt: string | null; live: boolean }) {
  const now = signal(Date.now());
  effect(() => {
    if (!props.live || props.endedAt) return;
    const timer = setInterval(() => now.set(Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const text = () => (props.endedAt ? elapsed(props.startedAt, Date.parse(props.endedAt)) : props.live ? elapsed(props.startedAt, now()) : null);
  return text() ? <Text class="shrink-0 text-xs tabular-nums text-muted-foreground">{text()}</Text> : null;
}

function stageIcon(status: WorktreeSetupStage["status"]): string {
  switch (status) {
    case "done": return "check";
    case "running": return "loader";
    case "failed": return "x";
    case "warning": return "circle-alert";
    case "skipped": return "minus";
    case "pending": return "circle";
  }
}

/** StageIcon: check, spinner, x, alert, minus, or an empty circle. */
function StageIcon(props: { status: WorktreeSetupStage["status"] }) {
  if (props.status === "running") return <Spinner size={16} />;
  if (props.status === "pending") return <View class="size-4 rounded-full border-2 border-muted-foreground" />;
  return <TimelineIcon name={stageIcon(props.status)} size={16} />;
}

function stageTone(status: WorktreeSetupStage["status"]): string {
  switch (status) {
    case "failed": return "text-destructive-foreground";
    case "warning": return "text-warning-foreground";
    case "pending": return "text-secondary-label opacity-40";
    default: return "text-secondary-label";
  }
}

function StageRow(props: { stage: WorktreeSetupStage; setupRunning: boolean; setupEndedAt: string | null; scriptName: string | null }) {
  const stage = props.stage;
  const label = stage.id === "setup-script" && props.scriptName ? props.scriptName : worktreeSetupStageLabel(stage.id);
  const trailing = stage.status === "pending" ? null : stage.status === "skipped" ? (stage.detail ?? "skipped")
    : stage.id === "checkout" && stage.status === "running" && stage.percent !== null ? `${stage.percent}%` : stage.detail;
  return (
    <View class="min-h-6 flex-row items-center gap-1.5" accessibilityLabel={`${label}: ${stage.status}`}>
      <View class={`size-6 shrink-0 items-center justify-center ${stage.status === "pending" ? "opacity-40" : ""}`}>
        <StageIcon status={stage.status} />
      </View>
      <View class="min-w-0 flex-1 flex-row">
        {stage.status === "running"
          ? <ShimmerText text={() => label} active={() => true} class="text-sm" />
          : <Text class={`truncate text-sm leading-relaxed ${stageTone(stage.status)}`}>{label}</Text>}
      </View>
      {trailing ? <Text class="min-w-0 truncate text-xs tabular-nums text-muted-foreground">{trailing}</Text> : null}
      {stage.status !== "skipped" && stage.status !== "pending" ? <Elapsed startedAt={stage.startedAt} endedAt={stage.endedAt ?? props.setupEndedAt} live={props.setupRunning} /> : null}
    </View>
  );
}

const TAIL_LINES = 4;

function OutputTail(props: { lines: string[]; failed: boolean }) {
  const rows = Array.from({ length: TAIL_LINES }, (_, slot) => props.lines[props.lines.length - TAIL_LINES + slot] ?? "");
  return (
    <View class={`mb-1 ml-8 rounded-md border px-2.5 py-1.5 ${props.failed ? "border-error bg-error-surface" : "border-border bg-code-background"}`} selectable>
      {rows.map((line) => <Text class={`truncate font-mono text-2xs leading-relaxed ${props.failed ? "text-destructive-foreground" : "text-muted-foreground"}`}>{line.length === 0 ? " " : line}</Text>)}
    </View>
  );
}

function SetupDetails(props: { snapshot: WorktreeSetupSnapshot }) {
  const row = (label: string, value: string | null | undefined) => value ? (
    <View class="flex-row gap-3">
      <Text class="w-12 text-xs text-foreground">{label}</Text>
      <MiddleTruncate value={value} class="flex-1" textClass="font-mono text-xs text-muted-foreground" />
    </View>
  ) : null;
  return (
    <View class="mb-1.5 ml-8 mt-1 gap-0.5">
      {row("Branch", props.snapshot.branch)}
      {row("Base", props.snapshot.baseRef)}
      {row("Path", props.snapshot.worktreePath)}
      {row("Setup", props.snapshot.setupScript?.command)}
    </View>
  );
}

function ActionButton(props: { label: string; icon?: string; onPress: () => void; expanded?: boolean }) {
  return (
    <View class="h-6 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent" onPress={props.onPress} accessibilityLabel={props.label}
      accessibilityState={props.expanded === undefined ? undefined : { expanded: props.expanded }} role="button">
      {props.expanded !== undefined
        ? <ChevronTurn open={() => props.expanded === true} durationMs={200}><Icon name="chevron-right" size={14} /></ChevronTurn>
        : props.icon ? <TimelineIcon name={props.icon} size={14} /> : null}
      <Text class="text-xs text-muted-foreground">{props.label}</Text>
    </View>
  );
}

export function WorktreeSetupCard(props: { snapshot: () => WorktreeSetupSnapshot; embedded?: boolean; send?: (method: string, payload: unknown) => Promise<unknown>; /** Offered while the thread is still a draft (ChatView passes it only with a draftId). */ onWorkLocally?: () => void }) {
  const detailsOpen = signal(false);
  const snapshot = props.snapshot;
  const running = () => snapshot().phase === "running";
  const setupStage = () => snapshot().stages.find((stage) => stage.id === "setup-script");
  const terminalId = () => snapshot().setupScript?.terminalId ?? null;
  const showTerminal = () => terminalId() !== null && setupStage() !== undefined && setupStage()?.status !== "pending";
  const collapsed = () => props.embedded === true && !running();
  const showHeader = () => props.embedded !== true && !running() && snapshot().phase !== "done";
  const showTail = () => { const stage = setupStage(); return stage !== undefined && (stage.status === "failed" || (stage.status === "running" && stage.tail.length > 0)); };
  const failedStage = () => snapshot().phase === "done" && snapshot().stages.some((stage) => stage.status === "failed");
  const summaryStatus = (): WorktreeSetupStage["status"] => snapshot().phase === "failed" || snapshot().phase === "cancelled" || snapshot().stages.some((stage) => stage.id === "setup-script" && stage.status === "failed") ? "failed" : "done";
  const cancel = () => { void (props.send ?? requestBackend)("worktreeSetup.cancel", { threadId: snapshot().threadId }).catch(() => undefined); };
  return (
    <View accessibilityLabel="Worktree setup">
      {showHeader() ? (
        <View class="border-b border-border-60 pb-2 pt-1">
          <View class="h-6 min-w-0 flex-row items-center gap-2 px-1">
            {running() && !failedStage()
              ? <View class="min-w-0 flex-1 flex-row"><ShimmerText text={() => worktreeSetupHeaderLabel(snapshot())} active={() => true} class="text-sm leading-relaxed tabular-nums" /></View>
              : <Text class={`min-w-0 flex-1 truncate text-sm leading-relaxed tabular-nums ${snapshot().phase === "failed" ? "text-destructive-foreground" : failedStage() ? "text-warning-foreground" : "text-muted-foreground"}`}>{worktreeSetupHeaderLabel(snapshot())}</Text>}
            <Elapsed startedAt={snapshot().startedAt} endedAt={snapshot().endedAt} live={running()} />
          </View>
        </View>
      ) : null}
      {collapsed() ? (
        <View class="min-h-6 flex-row items-center gap-1.5">
          <View class="size-6 items-center justify-center"><StageIcon status={summaryStatus()} /></View>
          <Text class={`min-w-0 flex-1 truncate text-sm ${stageTone(summaryStatus())}`}>{worktreeSetupHeaderLabel(snapshot())}</Text>
          <Elapsed startedAt={snapshot().startedAt} endedAt={snapshot().endedAt} live={false} />
        </View>
      ) : (
        <View class={showHeader() ? "pt-1.5" : ""}>
          <Each of={snapshot().stages} key={(stage) => stage.id}>
            {(stage) => (
              <View>
                <StageRow stage={stage()} setupRunning={running()} setupEndedAt={snapshot().endedAt} scriptName={snapshot().setupScript?.name ?? null} />
                {stage().id === "setup-script" && showTail() ? <OutputTail lines={stage().tail} failed={stage().status === "failed"} /> : null}
              </View>
            )}
          </Each>
        </View>
      )}
      {snapshot().phase === "failed" && snapshot().error ? <Text class="ml-8 mt-1 text-xs text-muted-foreground">{snapshot().error}</Text> : null}
      {/* Reference: ml-[calc(--spacing(6)+2px-(--spacing(2)-1px))] = 24+2-7 = 19px (aligns the action row under the stage label, past its 24px icon cell). */}
      <View class="ml-[19px] mt-0.5 flex-row flex-wrap items-center gap-0.5">
        <ActionButton label="Details" expanded={detailsOpen()} onPress={() => detailsOpen.update((open) => !open)} />
        {showTerminal() ? <ActionButton label="Open terminal" icon="terminal" onPress={() => { const id = terminalId(); if (id) openTerminalIdAction(id); }} /> : null}
        {props.onWorkLocally ? <ActionButton label="Work locally" icon="laptop" onPress={props.onWorkLocally} /> : null}
        {props.embedded !== true && running() ? <ActionButton label="Cancel" icon="x" onPress={cancel} /> : null}
      </View>
      {detailsOpen() ? <SetupDetails snapshot={snapshot()} /> : null}
    </View>
  );
}

/** A `worktree-setup` timeline row, in the chat lane. */
export function WorktreeSetupRow(props: { snapshot: () => WorktreeSetupSnapshot; embedded: () => boolean; onWorkLocally?: () => void }) {
  return (
    <View class={`mx-auto w-full ${chatWidthClass()} pb-1.5`}>
      <WorktreeSetupCard snapshot={props.snapshot} embedded={props.embedded()} {...(props.onWorkLocally ? { onWorkLocally: props.onWorkLocally } : {})} />
    </View>
  );
}

/** BackgroundWorktreeSetupChip: "Background setup" in the working row; its popover shows the embedded card. */
export function BackgroundSetupChip(props: { snapshot: () => WorktreeSetupSnapshot }) {
  const open = signal(false);
  useOverlayOpen(open, "background setup");
  const scriptName = () => props.snapshot().setupScript?.name ?? "Setup script";
  return (
    <Popover
      onOpenChange={trackOpenChange(open)}
      placement="bottom"
      align="end"
      popupClass="w-[384px] rounded-lg border border-border bg-popover-84 px-3 py-2"
      trigger={
        <View class="h-5 min-w-0 shrink-0 flex-row items-center gap-1 rounded-md px-1.5 hover:bg-accent" accessibilityLabel={`Background setup is still running: ${scriptName()}. Show setup progress.`} role="button">
          <Spinner size={12} />
          <Text class="truncate text-[11px] text-muted-foreground">Background setup</Text>
        </View>
      }
    >
      <WorktreeSetupCard snapshot={props.snapshot} embedded />
    </Popover>
  );
}
