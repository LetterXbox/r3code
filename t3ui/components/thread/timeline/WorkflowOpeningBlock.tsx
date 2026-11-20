// chat/WorkflowOpeningBlock.tsx + subagentRuntime.ts resolveWorkflowOpening/workflowOpeningHeadline: a provider-native
// workflow coordinator's thread opens with its script; the block shows "Workflow started", the workflow's name and
// description, an agent tally, its phases with member rows (press opens the member's thread), and the script folded.
// The coordinator row lives on the parent thread, read with orchestration.getThreadProjection.
import { effect, signal, Text, View } from "nsh";
import { ChatMarkdown } from "../markdown/ChatMarkdown";
import { TimelineIcon } from "../markdown/TimelineIcon";
import { Icon } from "../../Icons";
import { createHover } from "../../hoverReveal";
import { deriveWorkflowGroups, isTerminalAgentStatus, readProjectedAgents, type ProjectedAgent, type WorkflowGroup, type WorkflowMember } from "../../header/workflowModel";
import { shouldCollapseUserMessage } from "./userMessage";
import { formatElapsed } from "./workLog";

// Consume each comment through its terminator so divider lines cannot backtrack.
const WORKFLOW_SCRIPT_START =
  /^\s*(?:(?:\/\/[^\r\n\u2028\u2029]*(?:[\r\n\u2028\u2029]|$)|\/\*(?:[^*]|\*(?!\/))*\*\/)\s*)*export\s+const\s+meta\b/;

export interface WorkflowOpening {
  messageId: string;
  script: string;
  name: string | null;
  description: string | null;
  /** Null until the parent thread's coordinator row is loaded. */
  group: WorkflowGroup | null;
}

/** isWorkflowScriptMessage: the server's workflowScript flag, else a script that starts with `export const meta`. */
export function isWorkflowScriptMessage(message: { role: string; text: string; workflowScript?: boolean }): boolean {
  return message.role === "user" && (message.workflowScript ?? WORKFLOW_SCRIPT_START.test(message.text));
}

/** resolveWorkflowOpening: the first user message of a provider-native subagent thread, when it is a workflow script. */
export function resolveWorkflowOpening(input: {
  threadId: string;
  providerNativeSubagent: boolean;
  messages: readonly { id: string; role: string; text: string; workflowScript?: boolean }[];
  parentAgents: readonly ProjectedAgent[] | null;
}): WorkflowOpening | null {
  if (!input.providerNativeSubagent) return null;
  const first = input.messages.find((message) => message.role === "user");
  if (!first || first.workflowScript === false) return null;
  const coordinator = input.parentAgents?.find((agent) => agent.childThreadId === input.threadId);
  const workflow = coordinator?.workflow ?? null;
  if (workflow === null && !isWorkflowScriptMessage(first)) return null;
  return {
    messageId: first.id,
    script: first.text,
    name: workflow?.name ?? null,
    description: coordinator?.title ?? null,
    group: coordinator && workflow ? deriveWorkflowGroups([coordinator])[0] ?? null : null,
  };
}

/** workflowOpeningHeadline: the title, a distinct description, and "3 agents · 1 working · 2 done". */
export function workflowOpeningHeadline(opening: WorkflowOpening): { title: string; description: string | null; agents: string | null } {
  const title = opening.name ?? opening.description ?? "Workflow";
  const members = opening.group === null ? [] : [...opening.group.phases.flatMap((phase) => phase.members), ...opening.group.unphasedMembers];
  const counts = new Map<string, number>();
  for (const member of members) {
    const key = isTerminalAgentStatus(member.status) ? (member.status === "completed" ? "done" : member.status === "failed" ? "failed" : "stopped") : "working";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const agents = members.length === 0
    ? null
    : `${members.length} ${members.length === 1 ? "agent" : "agents"} · ${["working", "done", "failed", "stopped"].filter((key) => counts.has(key)).map((key) => `${counts.get(key)} ${key}`).join(" · ")}`;
  return { title, description: opening.description !== null && opening.description !== title ? opening.description : null, agents };
}

function scriptMarkdown(script: string) {
  const longestRun = Math.max(2, ...(script.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  return `${fence}javascript\n${script.trimEnd()}\n${fence}`;
}

function memberDetail(member: WorkflowMember): string | null {
  const text = isTerminalAgentStatus(member.status) ? member.result : null;
  const cleaned = text?.replace(/`/g, "").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned : null;
}

function MemberRow(props: { member: WorkflowMember; now: () => number; onOpenThread: (threadId: string) => void }) {
  const hover = createHover();
  const threadId = props.member.childThreadId;
  const elapsed = () => {
    const started = props.member.startedAt;
    if (started === null) return null;
    return formatElapsed(Math.max(0, (props.member.completedAt ?? props.now()) - started));
  };
  return (
    <View
      class={`min-w-0 flex-row items-center gap-2.5 rounded-md px-2 py-1.5 ${threadId !== null && hover.hovered() ? "bg-accent-50" : ""}`}
      onPress={threadId !== null ? () => props.onOpenThread(threadId) : undefined}
      accessibilityLabel={threadId !== null ? `Open ${props.member.title}` : props.member.title}
      role={threadId !== null ? "button" : undefined}
      tooltip={props.member.status}
      {...hover.bind}
    >
      {props.member.status === "failed" ? <TimelineIcon name="circle-alert" size={14} /> : isTerminalAgentStatus(props.member.status) ? <TimelineIcon name="circle-check" size={14} /> : <Icon name="bot" size={14} />}
      <View class="min-w-0 flex-1">
        <Text class="truncate text-xs font-medium text-foreground">{props.member.title}</Text>
        {memberDetail(props.member) ? (
          <Text class={`truncate text-2xs leading-relaxed ${props.member.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>{memberDetail(props.member)}</Text>
        ) : null}
      </View>
      {elapsed() !== null ? <Text class="shrink-0 text-xs tabular-nums text-muted-foreground">{elapsed()}</Text> : null}
      {threadId !== null ? <Icon name="chevron-right" size={14} /> : null}
    </View>
  );
}

function WorkflowScript(props: { script: () => string }) {
  const expanded = signal(false);
  const canFold = () => shouldCollapseUserMessage(props.script());
  const folded = () => canFold() && !expanded();
  return (
    <View>
      <View class={folded() ? "max-h-44 overflow-hidden" : ""}>
        <ChatMarkdown text={() => scriptMarkdown(props.script())} />
      </View>
      {canFold() ? (
        <View class="-ms-1 h-6 self-start justify-center rounded-md px-2 hover:bg-accent" onPress={() => expanded.update((value) => !value)} accessibilityState={{ expanded: expanded() }} role="button">
          <Text class="text-xs text-muted-foreground">{expanded() ? "Show less" : "Show full script"}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function WorkflowOpeningBlock(props: { opening: () => WorkflowOpening; onOpenThread: (threadId: string) => void; now?: () => number }) {
  const clock = signal(Date.now());
  effect(() => {
    if (props.now) return;
    const timer = setInterval(() => clock.set(Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const now = () => (props.now ? props.now() : clock());
  const headline = () => workflowOpeningHeadline(props.opening());
  const phases = () => props.opening().group?.phases.filter((phase) => phase.members.length > 0) ?? [];
  return (
    <View class="min-w-0 gap-3 px-1 py-0.5" accessibilityLabel={`Workflow started: ${headline().title}`}>
      <View class="min-w-0 flex-row items-start gap-2">
        <View class="mt-0.5"><TimelineIcon name="workflow" size={14} /></View>
        <View class="min-w-0 flex-1 gap-0.5">
          <Text class="text-2xs font-medium text-muted-foreground">Workflow started</Text>
          <Text class="truncate text-sm font-medium text-foreground">{headline().title}</Text>
          {headline().description ? <Text class="text-xs text-muted-foreground">{headline().description}</Text> : null}
        </View>
        {headline().agents ? <Text class="shrink-0 text-2xs tabular-nums text-muted-foreground">{headline().agents}</Text> : null}
      </View>
      <Each of={phases()} key={(phase) => String(phase.index)}>
        {(phase) => (
          <View accessibilityLabel={`${phase().title} phase`}>
            <View class="flex-row items-baseline gap-2 px-2 pb-0.5">
              <Text class="min-w-0 truncate text-2xs font-medium text-muted-foreground">{phase().title}</Text>
              <Text class="shrink-0 text-2xs tabular-nums text-muted-foreground">{`${phase().settledCount}/${phase().members.length}`}</Text>
            </View>
            <Each of={phase().members} key={(member) => member.id}>
              {(member) => <MemberRow member={member()} now={now} onOpenThread={props.onOpenThread} />}
            </Each>
          </View>
        )}
      </Each>
      {props.opening().group && props.opening().group!.unphasedMembers.length > 0 ? (
        <Each of={props.opening().group!.unphasedMembers} key={(member) => member.id}>
          {(member) => <MemberRow member={member()} now={now} onOpenThread={props.onOpenThread} />}
        </Each>
      ) : null}
      <WorkflowScript script={() => props.opening().script} />
    </View>
  );
}

type Request = (method: string, payload: unknown) => Promise<unknown>;

/**
 * The parent thread's agents for the opening block, read with orchestration.getThreadProjection while the open thread is a
 * provider-native subagent whose first message is a workflow script; re-read every 5 s while any member is unsettled.
 */
export function useParentWorkflowAgents(parentThreadId: () => string | null, request: Request) {
  const agents = signal<ProjectedAgent[] | null>(null);
  effect(() => {
    const parent = parentThreadId();
    agents.set(null);
    if (!parent) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      void request("orchestration.getThreadProjection", { threadId: parent })
        .then((value) => {
          if (stopped) return;
          const next = readProjectedAgents(value);
          agents.set(next);
          const live = deriveWorkflowGroups(next).some((group) => [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers].some((member) => !isTerminalAgentStatus(member.status)));
          if (live) timer = setTimeout(load, 5000);
        })
        .catch(() => { if (!stopped) agents.set([]); });
    };
    load();
    return () => { stopped = true; clearTimeout(timer); };
  });
  return agents;
}
