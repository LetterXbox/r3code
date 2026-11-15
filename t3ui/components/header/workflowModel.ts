// The agents behind the Lineage section's richer rows (chat/ThreadRelationshipsControl.tsx, ThreadLineageWorkflowRow.tsx,
// client-runtime state/subagentRuntime.ts and threadWorkflows.ts): provider-native workflows with their phases and agents,
// which subagents the card may stop, and the merge-back of a fork. Pure, read off `orchestration.getThreadProjection`.

export interface WorkflowAgentRecord {
  index: number; label: string; state: "queued" | "running" | "completed" | "failed"; childThreadId: string | null;
  phaseIndex: number | null; phaseTitle: string | null; model: string | null; attempt: number | null;
  queuedAt: number | null; startedAt: number | null; completedAt: number | null; durationMs: number | null; result: string | null;
}
export interface WorkflowRecord { name: string | null; phases: { index: number; title: string }[]; agents: WorkflowAgentRecord[] }

/** One `projection.subagents` record with what the stop rules and workflow groups read. */
export interface ProjectedAgent {
  id: string; threadId: string; runId: string | null; origin: "provider_native" | "app_owned"; driver: string | null; providerInstanceId: string | null;
  childThreadId: string | null; title: string | null; status: string; startedAt: number | null; completedAt: number | null;
  nativeTask: { strength: string | null; nativeId: string | null } | null; workflow: WorkflowRecord | null;
  /** OrchestrationV2RemoteTaskChild: a task delegated to a linked environment (its thread lives there). */
  remoteChild?: { environmentId: string; threadId: string; label: string; title: string | null } | null;
}

const record = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const whole = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const time = (value: unknown): number | null => { const at = typeof value === "string" ? Date.parse(value) : Number.NaN; return Number.isFinite(at) ? at : null; };

function readWorkflow(value: unknown): WorkflowRecord | null {
  const workflow = record(value);
  if (!workflow) return null;
  const phases = (Array.isArray(workflow.phases) ? workflow.phases : []).flatMap((entry) => {
    const phase = record(entry);
    return phase && whole(phase.index) !== null && text(phase.title) ? [{ index: whole(phase.index)!, title: text(phase.title)! }] : [];
  });
  const agents = (Array.isArray(workflow.agents) ? workflow.agents : []).flatMap((entry): WorkflowAgentRecord[] => {
    const agent = record(entry);
    const state = agent?.state;
    if (!agent || whole(agent.index) === null || !text(agent.label) || (state !== "queued" && state !== "running" && state !== "completed" && state !== "failed")) return [];
    return [{
      index: whole(agent.index)!, label: text(agent.label)!, state, childThreadId: text(agent.childThreadId), phaseIndex: whole(agent.phaseIndex), phaseTitle: text(agent.phaseTitle),
      model: text(agent.model), attempt: whole(agent.attempt), queuedAt: whole(agent.queuedAt), startedAt: whole(agent.startedAt), completedAt: whole(agent.completedAt), durationMs: whole(agent.durationMs), result: text(agent.result),
    }];
  });
  return { name: text(workflow.name), phases, agents };
}

function readRemoteChild(value: unknown): ProjectedAgent["remoteChild"] {
  const child = record(value);
  const environmentId = text(child?.environmentId);
  const threadId = text(child?.threadId);
  return child && environmentId && threadId ? { environmentId, threadId, label: text(child.label) ?? environmentId, title: text(child.title) } : null;
}

export function readProjectedAgents(projection: unknown): ProjectedAgent[] {
  const root = record(projection);
  const list = root && Array.isArray(root.subagents) ? root.subagents : [];
  return list.flatMap((entry): ProjectedAgent[] => {
    const agent = record(entry);
    if (!agent || typeof agent.id !== "string" || typeof agent.status !== "string") return [];
    const ref = record(agent.nativeTaskRef);
    return [{
      id: agent.id, threadId: text(agent.threadId) ?? "", runId: text(agent.runId), origin: agent.origin === "provider_native" ? "provider_native" : "app_owned", driver: text(agent.driver),
      providerInstanceId: text(agent.providerInstanceId), childThreadId: text(agent.childThreadId), title: text(agent.title), status: agent.status,
      startedAt: time(agent.startedAt), completedAt: time(agent.completedAt),
      nativeTask: ref ? { strength: text(ref.strength), nativeId: text(ref.nativeId) } : null, workflow: readWorkflow(agent.workflow),
      remoteChild: readRemoteChild(agent.remoteChild),
    }];
  });
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const ACTIVE = new Set(["pending", "running", "waiting"]);
export const isTerminalAgentStatus = (status: string) => TERMINAL.has(status);
export const isActiveAgentStatus = (status: string) => ACTIVE.has(status);

export interface WorkflowMember {
  id: string; title: string; status: string; startedAt: number | null; completedAt: number | null; childThreadId: string | null;
  phaseIndex: number | null; agentIndex: number; result: string | null; model: string | null;
}
export interface WorkflowPhase { index: number; title: string; members: WorkflowMember[]; state: "pending" | "running" | "done"; settledCount: number }
export interface WorkflowGroup { agent: ProjectedAgent; name: string; phases: WorkflowPhase[]; unphasedMembers: WorkflowMember[] }

function membersOf(coordinator: ProjectedAgent, workflow: WorkflowRecord): WorkflowMember[] {
  return workflow.agents.map((agent) => {
    const status = (agent.state === "queued" || agent.state === "running") && isTerminalAgentStatus(coordinator.status) ? coordinator.status : agent.state === "queued" ? "pending" : agent.state;
    const completedAt = isTerminalAgentStatus(status)
      ? agent.completedAt ?? (agent.startedAt !== null && agent.durationMs !== null ? agent.startedAt + agent.durationMs : coordinator.completedAt)
      : null;
    return {
      id: `${coordinator.id}:agent:${agent.index}`, title: agent.label, status, startedAt: agent.startedAt, completedAt, childThreadId: agent.childThreadId,
      phaseIndex: agent.phaseIndex, agentIndex: agent.index, result: agent.result, model: agent.model,
    };
  });
}

/** deriveWorkflowGroups: each workflow coordinator with its phases (declared and member-implied) and unphased members. */
export function deriveWorkflowGroups(agents: readonly ProjectedAgent[]): WorkflowGroup[] {
  return agents.filter((agent) => agent.workflow !== null).map((agent) => {
    const workflow = agent.workflow!;
    const members = membersOf(agent, workflow);
    // The declared plan lags the members, so members seed the titles and the declared ones overwrite them.
    const titles = new Map<number, string>();
    for (const agentRecord of workflow.agents) if (agentRecord.phaseIndex !== null) titles.set(agentRecord.phaseIndex, agentRecord.phaseTitle ?? titles.get(agentRecord.phaseIndex) ?? `Phase ${agentRecord.phaseIndex + 1}`);
    for (const phase of workflow.phases) titles.set(phase.index, phase.title);
    const phases = [...titles].map(([index, title]) => ({ index, title })).sort((a, b) => a.index - b.index).map((phase): WorkflowPhase => {
      const phaseMembers = members.filter((member) => member.phaseIndex === phase.index).sort((a, b) => a.agentIndex - b.agentIndex);
      // Idle members count as active for phase liveness: a resumable member has not finished the phase.
      const active = phaseMembers.some((member) => isActiveAgentStatus(member.status) || member.status === "idle");
      return { index: phase.index, title: phase.title, members: phaseMembers, state: phaseMembers.length === 0 ? "pending" : active ? "running" : "done", settledCount: phaseMembers.filter((member) => isTerminalAgentStatus(member.status)).length };
    });
    return { agent, name: workflow.name ?? agent.title ?? "Workflow", phases, unphasedMembers: members.filter((member) => member.phaseIndex === null).sort((a, b) => a.agentIndex - b.agentIndex) };
  });
}

export function phaseStatusLabel(phase: WorkflowPhase): string {
  if (phase.state === "running") return "running";
  if (phase.members.some((member) => member.status === "failed")) return "failed";
  if (phase.members.some((member) => member.status === "cancelled" || member.status === "interrupted")) return "stopped";
  return phase.state === "done" ? "done" : "not started";
}

/** phaseElapsed: the span from the first member's start to the last one's end; none while a phase has not started. */
export function phaseElapsed(phase: WorkflowPhase): { status: "running" | "completed"; startedAt: number | null; completedAt: number | null } {
  const starts = phase.members.flatMap((member) => (member.startedAt === null ? [] : [member.startedAt])).sort((a, b) => a - b);
  const ends = phase.members.flatMap((member) => (member.completedAt === null ? [] : [member.completedAt])).sort((a, b) => a - b);
  const running = phase.state === "running";
  const startedAt = starts[0] ?? null;
  const completedAt = running ? null : ends.at(-1) ?? null;
  return { status: running ? "running" : "completed", startedAt: running || completedAt !== null ? startedAt : null, completedAt };
}

/** The "2/3 agents" count in a phase header. */
export const phaseCountLabel = (phase: WorkflowPhase) => `${phase.settledCount}/${phase.members.length} ${phase.members.length === 1 ? "agent" : "agents"}`;

/** Whether a Stop button shows on a subagent row (ThreadRelationshipsControl's canStop). */
export function canStopSubagent(agent: ProjectedAgent | undefined): boolean {
  if (!agent || agent.startedAt === null || !isActiveAgentStatus(agent.status)) return false;
  return agent.origin === "app_owned"
    || (agent.origin === "provider_native" && agent.driver === "claudeAgent" && agent.runId !== null && agent.nativeTask?.strength === "strong" && agent.nativeTask.nativeId !== null);
}

/** Whether a workflow row offers "Stop entire workflow". */
export function canStopWorkflow(agent: ProjectedAgent | undefined, canOperate: boolean): boolean {
  return canOperate && agent?.workflow != null && agent.status === "running" && agent.origin === "provider_native" && agent.driver === "claudeAgent";
}

// ---- Merge back ----

export interface MergeBackState {
  /** The thread a fork merges back into: the run it forked from, else its parent. Null unless the thread is a fork. */
  targetThreadId: string | null;
  /** The latest finished run in this fork with nothing running after it; null until one completes. */
  latestRunId: string | null;
}

const MERGE_BACK_RUN_STATUSES = new Set(["waiting", "completed"]);
const MERGE_BACK_BLOCKING = new Set(["preparing", "starting", "running"]);

export function readMergeBack(projection: unknown): MergeBackState {
  const root = record(projection);
  const thread = record(root?.thread);
  const lineage = record(thread?.lineage);
  if (lineage?.relationshipToParent !== "fork") return { targetThreadId: null, latestRunId: null };
  const forkedFrom = record(thread?.forkedFrom);
  const targetThreadId = forkedFrom?.type === "run" ? text(forkedFrom.threadId) : text(lineage.parentThreadId);
  const runs = (Array.isArray(root?.runs) ? root!.runs : []).flatMap((entry) => {
    const run = record(entry);
    return run && text(run.id) && whole(run.ordinal) !== null && typeof run.status === "string" ? [{ id: text(run.id)!, ordinal: whole(run.ordinal)!, status: run.status }] : [];
  });
  const finished = runs.filter((run) => MERGE_BACK_RUN_STATUSES.has(run.status)).sort((a, b) => b.ordinal - a.ordinal)[0] ?? null;
  const blocked = finished !== null && runs.some((run) => run.ordinal > finished.ordinal && MERGE_BACK_BLOCKING.has(run.status));
  return { targetThreadId, latestRunId: finished === null || blocked ? null : finished.id };
}

export const mergeBackLabel = (parentTitle: string | null) => (parentTitle ? `Merge back to ${parentTitle}` : "Merge back to source conversation");
export const mergeBackTooltip = (latestRunId: string | null, parentTitle: string | null) =>
  latestRunId === null ? "Complete a run in this fork before merging it back" : parentTitle ? `Merge this conversation back into ${parentTitle}` : "Merge this conversation back into its source";

// ---- Commands ----

type Request = (method: string, payload: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
const commandId = () => `command:${crypto.randomUUID()}`;

/** `thread.merge_back`: merges the fork's latest finished run into its source. */
export function mergeBack(input: { sourceThreadId: string; targetThreadId: string; runId: string }, request: Request): Promise<unknown> {
  return request("orchestration.dispatchCommand", { type: "thread.merge_back", commandId: commandId(), createdBy: "user", creationSource: "web", sourceThreadId: input.sourceThreadId, targetThreadId: input.targetThreadId, sourcePoint: { type: "run", runId: input.runId } });
}

/**
 * interruptThreadTurn with a subagentId: an app-owned task ends from its parent (`subagent.stop`) and then its child
 * thread stops; a provider-native one stops through its run.
 */
export async function stopSubagent(agent: Pick<ProjectedAgent, "id" | "threadId" | "runId" | "origin" | "childThreadId">, request: Request): Promise<void> {
  if (agent.origin === "app_owned" && agent.childThreadId !== null) {
    if (agent.runId !== null) await request("orchestration.dispatchCommand", { type: "subagent.stop", commandId: commandId(), threadId: agent.threadId, runId: agent.runId, subagentId: agent.id }).catch(() => undefined);
    await request("orchestration.dispatchCommand", { type: "thread.stop", commandId: commandId(), threadId: agent.childThreadId });
    return;
  }
  if (agent.runId === null) return;
  await request("orchestration.dispatchCommand", { type: "subagent.stop", commandId: commandId(), threadId: agent.threadId, runId: agent.runId, subagentId: agent.id });
}

/** `orchestration.stopWorkflow`: stops the whole provider-native workflow. */
export function stopWorkflow(input: { threadId: string; subagentId: string }, request: Request): Promise<unknown> {
  return request("orchestration.stopWorkflow", input);
}
