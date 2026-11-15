// The Lineage rows (chat/ThreadRelationshipsControl.tsx renderRelationshipRow, DelegatedFromRow and
// ThreadLineageWorkflowRow.tsx): a thread or agent row with its provider mark and status dot, the split row of a fork's
// merge-back target, the hover Stop of a live subagent, and a workflow's expandable phases and agents.
import { SubagentHoverCard } from "../thread/timeline/SubagentRows";
import type { SubagentFields } from "../thread/timeline/subagents";
import { signal, Text, View } from "nsh";
import { Tooltip } from "nsh/base";
import { openThreadById } from "../../store";
import { openSideChatAction } from "../rightPanel/panelState";
import { providerMetaFor } from "../composer/providerCatalog";
import { Chevron } from "../Icons";
import { ChevronTurn } from "../motion/Motion";
import { PRIcon } from "../pullRequest/PRIcon";
import { ProviderIconView } from "../../pages/settings/providers/ui";
import { HIcon } from "./HeaderIcons";
import { agentElapsedLabel, formatSubagentDisplayTitle, relationshipDotClass, relationshipStatusLabel, type LineageRow } from "./lineageLogic";
import { mergeBackLabel, mergeBackTooltip, phaseCountLabel, phaseElapsed, phaseStatusLabel, type MergeBackState, type ProjectedAgent, type WorkflowGroup, type WorkflowMember } from "./workflowModel";
import { canStopSubagent, canStopWorkflow } from "./workflowModel";

const rowClass = "min-h-8 w-full flex-row items-center gap-2.5 rounded-lg px-2.5 hover:bg-details-row-hover";

function Tip(props: { title: string; hint?: string }) {
  return (
    <Tooltip class="max-w-80 rounded-md border border-border bg-popover px-2 py-1">
      <Text class="text-xs font-medium text-popover-foreground">{props.title}</Text>
      {props.hint ? <Text class="text-xs text-muted-foreground">{props.hint}</Text> : null}
    </Tooltip>
  );
}

/** ThreadRelationshipIcon: the provider's mark (or the relation's) with a status dot at its corner. */
export function RelationIcon(props: { row: Pick<LineageRow, "providerInstanceId" | "isAgent" | "isParent" | "kind" | "status"> }) {
  const meta = () => (props.row.providerInstanceId ? providerMetaFor(props.row.providerInstanceId) : null);
  const fallback = () => (props.row.isParent ? "corner-left-up" : props.row.kind === "subagent" ? "bot" : props.row.kind === "side-chat" ? "messages-square" : "git-fork");
  return (
    <View class="relative size-4 shrink-0 items-center justify-center">
      {meta() && props.row.isAgent ? <ProviderIconView driver={meta()!.driver} name={meta()!.displayName} size={16} /> : <HIcon name={fallback()} size={16} />}
      <View class={`absolute -bottom-1 -right-1 size-2 rounded-full border-2 border-popover-84 ${relationshipDotClass(props.row.status)}`} />
    </View>
  );
}

/** What the rows need from the section: the agents by child thread, the workflow groups, and the actions. */
export interface LineageContext {
  now: () => number;
  agentFor: (threadId: string) => ProjectedAgent | undefined;
  workflowFor: (agentId: string) => WorkflowGroup | undefined;
  mergeBack: () => MergeBackState;
  /** The merge target's title, or null while this client does not know it. */
  parentTitle: () => string | null;
  canOperate: () => boolean;
  /** The row's action that is running: "merge", or the id of the agent being stopped. */
  busy: () => string | null;
  onMerge: () => void;
  onStopSubagent: (agent: ProjectedAgent) => void;
  onStopWorkflow: (agent: ProjectedAgent) => void;
}

function StopButton(props: { label: string; hint: string; busy: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      tooltip={<Tip title={props.hint} />}
      disabled={props.disabled}
      onPress={props.onPress}
      class={`size-6 items-center justify-center rounded-md hover:bg-error-surface ${props.disabled ? "opacity-64" : ""}`}
    >
      {props.busy ? <HIcon name="loader-circle" size={12} /> : <View class="size-2.5 rounded-[2px] bg-destructive" />}
    </View>
  );
}

function memberElapsed(member: Pick<WorkflowMember, "status" | "startedAt" | "completedAt">, now: number): string | null {
  return agentElapsedLabel({ status: member.status, startedAt: member.startedAt, completedAt: member.completedAt }, now);
}

/** SubagentTooltipContent's fields for a projected subagent row. */
function agentHoverFields(agent: ProjectedAgent, title: string): SubagentFields {
  return {
    subagentId: agent.id, providerInstanceId: agent.providerInstanceId ?? "", driver: agent.driver ?? "", origin: agent.origin, childThreadId: agent.childThreadId,
    remoteLabel: null, title, status: agent.status, progress: null, result: null, startedAt: agent.startedAt, completedAt: agent.completedAt,
    runId: agent.runId, providerTurnId: null, model: null,
  };
}

/** ThreadLineageWorkflowRow: a workflow member's hover card (model, status, elapsed, result). */
function memberHoverFields(member: WorkflowMember, agent: ProjectedAgent): SubagentFields {
  return {
    subagentId: member.id, providerInstanceId: agent.providerInstanceId ?? "", driver: agent.driver ?? "", origin: agent.origin, childThreadId: member.childThreadId,
    remoteLabel: null, title: member.title, status: member.status, progress: null, result: member.result, startedAt: member.startedAt, completedAt: member.completedAt,
    runId: agent.runId, providerTurnId: null, model: member.model,
  };
}

function MemberRow(props: { member: WorkflowMember; agent: ProjectedAgent; now: () => number }) {
  const member = () => props.member;
  const elapsed = () => memberElapsed(member(), props.now());
  const canOpen = () => member().childThreadId !== null;
  return (
    <View
      role="button"
      accessibilityLabel={`Open ${member().title} chat`}
      disabled={!canOpen()}
      onPress={() => { const id = member().childThreadId; if (id) openThreadById(id); }}
      tooltip={<SubagentHoverCard agent={() => memberHoverFields(member(), props.agent)} now={props.now} />}
      class={`${rowClass} h-8 ${canOpen() ? "" : "opacity-64"}`}
    >
      <RelationIcon row={{ providerInstanceId: props.agent.providerInstanceId, isAgent: true, isParent: false, kind: "subagent", status: member().status }} />
      <Text class="min-w-0 flex-1 truncate text-sm font-medium leading-4 text-details-title">{member().title}</Text>
      {member().startedAt !== null && elapsed() !== null ? <Text class="shrink-0 text-2xs font-normal tabular-nums text-muted-foreground">{elapsed()}</Text> : null}
    </View>
  );
}

/** The phases (the running one open) and agents of an expanded workflow. */
function WorkflowBody(props: { group: () => WorkflowGroup; now: () => number }) {
  const open = signal<Record<number, boolean>>({});
  const phases = () => props.group().phases.filter((phase) => phase.members.length > 0);
  const agent = () => props.group().agent;
  const isOpen = (index: number, running: boolean) => open()[index] ?? running;
  return (
    <View class="pl-6">
      <Each of={phases()} key={(phase) => String(phase.index)}>
        {(phase) => {
          const status = () => phaseStatusLabel(phase());
          const span = () => { const value = phaseElapsed(phase()); return value.startedAt === null ? null : agentElapsedLabel({ status: value.status === "running" ? "running" : "completed", startedAt: value.startedAt, completedAt: value.completedAt }, props.now()); };
          return (
            <View>
              <View
                role="button"
                accessibilityLabel={`${isOpen(phase().index, phase().state === "running") ? "Collapse" : "Expand"} ${phase().title} phase, ${status()}`}
                onPress={() => open.update((all) => ({ ...all, [phase().index]: !isOpen(phase().index, phase().state === "running") }))}
                class={`${rowClass} h-8`}
              >
                <Text class={`min-w-0 flex-1 truncate text-[13px] ${phase().state === "running" ? "font-medium text-details-label" : "font-normal text-muted-foreground"}`}>{phase().title}</Text>
                {status() === "failed" ? <Text class="shrink-0 text-2xs text-destructive">Failed</Text> : null}
                <Text class="shrink-0 text-2xs font-normal tabular-nums text-muted-foreground">{phaseCountLabel(phase())}</Text>
                {span() ? <Text class="shrink-0 text-2xs font-normal tabular-nums text-muted-foreground">{span()}</Text> : null}
                <Chevron collapsed={!isOpen(phase().index, phase().state === "running")} />
              </View>
              {isOpen(phase().index, phase().state === "running") ? <Each of={phase().members} key={(member) => member.id}>{(member) => <MemberRow member={member()} agent={agent()} now={props.now} />}</Each> : null}
            </View>
          );
        }}
      </Each>
      <Each of={props.group().unphasedMembers} key={(member) => member.id}>{(member) => <MemberRow member={member()} agent={agent()} now={props.now} />}</Each>
      {phases().length === 0 && props.group().unphasedMembers.length === 0 ? <Text class="px-2.5 py-1.5 text-2xs text-muted-foreground-80">No agents yet</Text> : null}
    </View>
  );
}

export function LineageRowView(props: { row: LineageRow; ctx: LineageContext }) {
  const row = () => props.row;
  const ctx = () => props.ctx;
  const hover = signal(false);
  const expanded = signal(false);
  const agent = () => (row().isParent ? undefined : ctx().agentFor(row().threadId));
  const group = () => { const current = agent(); return current ? ctx().workflowFor(current.id) : undefined; };
  const mergeTarget = () => row().threadId === ctx().mergeBack().targetThreadId;
  const title = () => group()?.name ?? row().title;
  const failed = () => row().status === "failed" || row().status === "error";
  const elapsed = () => (row().isAgent && !failed() ? agentElapsedLabel(row(), ctx().now()) : null);
  const stoppable = () => (group() ? canStopWorkflow(agent(), ctx().canOperate()) : canStopSubagent(agent()));
  const stopBusy = () => { const current = agent(); return current !== undefined && ctx().busy() === (group() ? current.id : row().threadId); };
  const busy = () => ctx().busy() !== null;
  const trailing = () => (elapsed() !== null
    ? <Text class={`shrink-0 text-2xs font-normal tabular-nums text-muted-foreground ${stoppable() && hover() ? "opacity-0" : ""}`}>{elapsed()}</Text>
    : mergeTarget() || group() ? null : <Text class={`shrink-0 text-2xs ${failed() ? "text-destructive" : "text-muted-foreground"} ${stoppable() && hover() ? "opacity-0" : ""}`}>{relationshipStatusLabel(row().status)}</Text>);
  const primary = (flex: boolean) => (
    <View
      role="button"
      accessibilityLabel={mergeTarget() ? `${title()} ${relationshipStatusLabel(row().status)}` : title()}
      tooltip={agent() && !group() ? <SubagentHoverCard agent={() => agentHoverFields(agent()!, title())} now={ctx().now} /> : <Tip title={title()} hint={`Open ${row().label.toLowerCase()} in this chat`} />}
      // ThreadRelationshipsControl.tsx: a side chat opens as the panel's side-chat tab, not as the main thread.
      onPress={() => (row().kind === "side-chat" ? openSideChatAction(row().threadId) : openThreadById(row().threadId))}
      class={`${flex ? "min-h-8 min-w-0 flex-1 flex-row items-center gap-2.5 rounded-lg px-2.5 hover:bg-details-row-hover" : rowClass} h-8`}
    >
      <RelationIcon row={row()} />
      <Text class="min-w-0 flex-1 truncate text-sm font-medium leading-4 text-details-title">{title()}</Text>
      {trailing()}
    </View>
  );
  const stop = () => {
    const current = agent();
    if (!current || !stoppable() || !(hover() || stopBusy())) return null;
    return (
      <View class="absolute right-1 top-1 z-10">
        <StopButton
          label={group() ? `Stop workflow ${title()}` : `Stop subagent ${title()}`}
          hint={group() ? "Stop entire workflow" : "Stop subagent"}
          busy={stopBusy()}
          disabled={busy()}
          onPress={() => (group() ? ctx().onStopWorkflow(current) : ctx().onStopSubagent(current))}
        />
      </View>
    );
  };
  return (
    <View onMouseEnter={() => hover.set(true)} onMouseLeave={() => hover.set(false)}>
      {mergeTarget() ? (
        <View class="relative h-8 flex-row items-center rounded-lg">
          {primary(true)}
          <View class="h-4 w-px bg-border" />
          <View
            role="button"
            accessibilityLabel={mergeBackLabel(ctx().parentTitle())}
            tooltip={<Tip title={mergeBackTooltip(ctx().mergeBack().latestRunId, ctx().parentTitle())} />}
            disabled={ctx().mergeBack().latestRunId === null || busy()}
            onPress={ctx().onMerge}
            class={`h-8 w-8 items-center justify-center rounded-lg hover:bg-details-row-hover ${ctx().mergeBack().latestRunId === null || busy() ? "opacity-64" : ""}`}
          >
            {ctx().busy() === "merge" ? <HIcon name="loader-circle" size={12} /> : <PRIcon name="git-merge" size={12} />}
          </View>
          <Text class="shrink-0 pl-1 pr-2.5 text-2xs font-medium text-muted-foreground">{relationshipStatusLabel(row().status)}</Text>
        </View>
      ) : group() ? (
        <>
          <View class="relative h-8 flex-row items-center rounded-lg">
            {primary(true)}
            <View class="h-4 w-px bg-border" />
            <View
              role="button"
              accessibilityLabel={`${expanded() ? "Collapse" : "Expand"} ${title()}`}
              onPress={() => expanded.update((value) => !value)}
              class="h-8 w-8 items-center justify-center rounded-lg hover:bg-details-row-hover"
            >
              <ChevronTurn open={expanded} degrees={180}><HIcon name="chevrons-up-down" size={14} /></ChevronTurn>
            </View>
            {stop()}
          </View>
          {expanded() ? <WorkflowBody group={() => group()!} now={ctx().now} /> : null}
        </>
      ) : (
        <View class="relative">
          {primary(false)}
          {stop()}
        </View>
      )}
    </View>
  );
}

/**
 * The thread on a linked environment whose agent delegated this one. It opens there when this client is connected to that
 * environment; this client reaches one environment, so the row names it and explains why it cannot open.
 */
export function DelegatedFromRow(props: { delegatedFrom: { environmentId: string; threadId: string; title: string }; fallbackLabel: string | null | undefined; openable?: boolean; onOpen?: () => void }) {
  const label = () => props.fallbackLabel ?? null;
  const title = () => props.delegatedFrom.title || "Parent thread";
  return (
    <View
      role="button"
      accessibilityLabel={title()}
      tooltip={<Tip title={title()} hint={props.openable ? "Open parent agent" : `Delegated from ${label() ?? "a linked environment"}. Connect to it to open the parent thread.`} />}
      onPress={() => { if (props.openable) props.onOpen?.(); }}
      class={`${rowClass} h-8`}
    >
      <HIcon name="corner-left-up" size={16} />
      <Text class="min-w-0 flex-1 truncate text-sm font-medium leading-4 text-details-title">{title()}</Text>
      {label() ? <Text class="shrink-0 text-2xs text-muted-foreground">{`on ${label()}`}</Text> : null}
    </View>
  );
}

/** ThreadRelationshipsControl RemoteSubagentRow: a task delegated to a linked environment, "on <label> · <status>"; it
 * opens the thread there when this app is connected to that machine. */
export function RemoteSubagentRow(props: { agent: ProjectedAgent; openKey: string | null; onOpen: (key: string) => void }) {
  const child = () => props.agent.remoteChild!;
  const title = () => formatSubagentDisplayTitle(props.agent.title ?? "Subagent");
  const failed = () => props.agent.status === "failed";
  return (
    <View
      role="button"
      accessibilityLabel={title()}
      disabled={props.openKey === null}
      tooltip={<Tip title={title()} hint={props.openKey === null ? `Runs on ${child().label}. Connect to it to open the thread there.` : `Open on ${child().label}`} />}
      onPress={() => { if (props.openKey) props.onOpen(props.openKey); }}
      class={`${rowClass} h-8`}
    >
      <RelationIcon row={{ providerInstanceId: props.agent.providerInstanceId, isAgent: true, isParent: false, kind: "subagent", status: props.agent.status }} />
      <Text class="min-w-0 flex-1 truncate text-sm font-medium leading-4 text-details-title">{title()}</Text>
      <Text class={`shrink-0 text-2xs ${failed() ? "text-destructive" : "text-muted-foreground"}`}>{`on ${child().label} \u00b7 ${relationshipStatusLabel(props.agent.status)}`}</Text>
    </View>
  );
}
