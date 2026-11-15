// Subagent rows, ported from the web app's TimelineV2EventRow.tsx (V2SubagentGroup) and V2LifecycleRow.tsx
// (SubagentTimelineLink, SubagentAvatar): a stack of provider avatars with the group's counts and elapsed time
// that opens a bordered panel of two-line rows, one per child. Pressing a row opens the child thread.
import { effect, signal, Text, token, View } from "nsh";
import { tokenAlpha } from "../../composer/tokenColor";
import { Tooltip } from "nsh/base";
import { chatWidthClass } from "../layout";
import { Icon } from "../../Icons";
import { TimelineIcon } from "../markdown/TimelineIcon";
import { ProviderIconView } from "../../../pages/settings/providers/ui";
import { providerMetaFor } from "../../composer/providerCatalog";
import { TraitsSpeedIcon } from "../../composer/TraitsSpeedIcon";
import { parseDescriptors, speedIconFor } from "../../composer/modelTraits";
import { allProjects, availableModels, openThread, openThreadById, threadById } from "../../../store";
import { storeThreadKey } from "../../../environments/machineMentions";
import { subagentWorkspaceRows } from "./subagentWorkspace";
import { trackOpenChange } from "../../rightPanel/nativeOcclusion";
import { FloatingRegion } from "../../rightPanel/FloatingRegion";
import {
  formatSubagentDisplayTitle, formatSubagentElapsed, subagentActive, subagentCountLabel, subagentGroupSummary, subagentGroupTiming,
  subagentDetailPreview, subagentRowDetail, subagentStatusVisual, subagentTrailingStatus, summarizeSubagentStatuses, type SubagentFields, type SubagentLinkEvent,
} from "./subagents";

const lane = () => `mx-auto w-full ${chatWidthClass()}`;

/** One clock for every elapsed label of a row; it ticks only while a child is working. */
function useClock(active: () => boolean) {
  const now = signal(Date.now());
  effect(() => {
    if (!active()) return;
    now.set(Date.now());
    const timer = setInterval(() => now.set(Date.now()), 1000);
    return () => clearInterval(timer);
  });
  return now;
}

const DOT_CLASS = { info: "bg-info", success: "bg-success", destructive: "bg-destructive", muted: "bg-muted-foreground-80" } as const;

/** SubagentAvatar: the provider's mark in a round chip; `status` adds the dot (the group's header omits it). */
export function SubagentAvatar(props: { agent: () => SubagentFields; status?: () => string | undefined; overlap?: boolean }) {
  const name = () => providerMetaFor(props.agent().providerInstanceId)?.displayName ?? props.agent().driver;
  const accent = () => providerMetaFor(props.agent().providerInstanceId)?.accentColor ?? null;
  const status = () => props.status?.();
  return (
    <View class={`${props.overlap ? "-ms-1.5 " : ""}size-6 shrink-0 items-center justify-center rounded-full border-2 border-background`}>
      <View class="size-6 items-center justify-center rounded-full border border-border-70 bg-muted">
        {props.agent().driver ? <ProviderIconView driver={props.agent().driver} instanceId={props.agent().providerInstanceId} name={name()} accentColor={accent()} size={14} /> : <Icon name="bot" size={14} />}
      </View>
      {status() ? <View class={`absolute bottom-0 right-0 size-2 rounded-full border-2 border-background ${DOT_CLASS[subagentStatusVisual(status() ?? "").dot]}`} testID={`subagent-dot-${subagentStatusVisual(status() ?? "").dot}`} /> : null}
    </View>
  );
}

/** SubagentTooltipContent: the card a row opens on hover: title, model, status with elapsed time, and the latest line. */
export function SubagentHoverCard(props: { agent: () => SubagentFields; now: () => number }) {
  const open = signal(false);
  const agent = props.agent;
  const status = () => subagentStatusVisual(agent().status);
  const preview = () => subagentDetailPreview(agent());
  // getTraitsSpeedDisplay over the child's model: Fast mode on, or the Fast / Ultrafast service tier.
  const speedIcon = () => {
    const selection = agent().selection;
    const found = selection ? availableModels().find((entry) => entry.provider === selection.instanceId && entry.model === selection.model) : undefined;
    return selection && found ? speedIconFor(parseDescriptors(found.optionDescriptors), selection.options) : null;
  };
  const statusClass = () => (subagentActive(agent().status) ? "text-info" : agent().status === "failed" ? "text-error" : agent().status === "completed" ? "text-success" : "text-muted-foreground");
  return (
    <Tooltip placement="right" align="start" offset={4} onOpenChange={trackOpenChange(open)} class="max-w-80 rounded-lg border border-border bg-popover-84 shadow-xl">
      <FloatingRegion label="subagent hover card">
      <View class="min-w-0 max-w-80 gap-2 px-1 py-2">
        <Text class="min-w-0 truncate text-xs font-medium leading-tight text-foreground">{formatSubagentDisplayTitle(agent().title)}</Text>
        <View class="gap-1.5 pl-0.5">
          <View class="min-w-0 flex-row items-center gap-2">
            {agent().driver ? <View class="opacity-60"><ProviderIconView driver={agent().driver} name={providerMetaFor(agent().providerInstanceId)?.displayName ?? agent().driver} size={12} /></View> : <Icon name="bot" size={12} tint={token("muted-foreground")} />}
            <View class="min-w-0 flex-row items-center gap-1">
              <Text class="min-w-0 truncate text-xs text-foreground">{agent().model ?? "Not reported"}</Text>
              {speedIcon() || agent().effort ? (
                <View class="shrink-0 flex-row items-center gap-1">
                  {agent().effort ? <Text class="text-xs text-foreground">{"\u00b7"}</Text> : null}
                  {/* TraitsSpeedIcon (size xs): the bolt, or the ultrafast mark, in the text's own colour, with its screen reader text. */}
                  {speedIcon() ? <TraitsSpeedIcon driver={agent().driver} speedIcon={speedIcon()!} size="xs" /> : null}
                  {agent().effort ? <Text class="text-xs text-foreground">{agent().effort}</Text> : null}
                </View>
              ) : null}
            </View>
          </View>
          <View class="min-w-0 flex-row items-center justify-between gap-4">
            <View class="flex-row items-center gap-1">
              <TimelineIcon name={subagentActive(agent().status) ? "circle-dashed" : agent().status === "failed" || agent().status === "error" ? "circle-x" : agent().status === "completed" ? "check" : "circle-dashed"} size={12} tint={token(subagentActive(agent().status) ? "info" : agent().status === "failed" || agent().status === "error" ? "error" : agent().status === "completed" ? "success" : "muted-foreground")} />
              <Text class={`text-xs font-medium ${statusClass()}`}>{status().label}</Text>
            </View>
            <Text class="text-xs tabular-nums text-muted-foreground">{formatSubagentElapsed(agent(), props.now())}</Text>
          </View>
          <Each of={subagentWorkspaceRows(openThread(), agent().childThreadId ? threadById(agent().childThreadId!) : undefined, allProjects())} key={(row) => row.label}>
            {(row) => (
              <View class="min-w-0 flex-row items-center gap-2" accessibilityLabel={row().label}>
                <Icon name={row().label === "Branch" ? "git-branch" : "folder"} size={12} tint={token("muted-foreground")} />
                <Text class="min-w-0 truncate text-xs text-foreground">{row().value}</Text>
              </View>
            )}
          </Each>
          {preview() ? (
            <View class="min-w-0 flex-row items-start gap-2">
              <Icon name="terminal" size={12} tint={token("muted-foreground")} />
              <Text class="min-w-0 flex-1 text-xs leading-snug text-foreground">{preview()}</Text>
            </View>
          ) : null}
        </View>
      </View>
      </FloatingRegion>
    </Tooltip>
  );
}

/** SubagentTimelineLink: avatar with status dot, title, one detail line, status word, elapsed time and a chevron. */
export function SubagentRow(props: { agent: () => SubagentFields; now: () => number; onOpen?: (threadId: string) => void; /** SubagentNotificationLink: a notification's outcome, label and time in place of the live status and elapsed time. */ event?: () => SubagentLinkEvent | undefined }) {
  const agent = props.agent;
  const event = () => props.event?.();
  const status = () => { const current = event(); return current ? current.status ?? undefined : agent().status; };
  const statusLabel = () => event()?.label ?? subagentStatusVisual(agent().status).label;
  const detail = () => subagentRowDetail({ ...agent(), status: status() ?? agent().status });
  const failed = () => status() === "failed";
  const trailing = () => event() ? (detail() !== null ? statusLabel() : null) : subagentTrailingStatus(agent());
  // V2LifecycleRow: a task in a linked environment opens there, if this app is connected to it.
  const threadId = () => {
    const child = agent().childThreadId;
    if (child) return child;
    const remote = agent().remote;
    if (!remote) return null;
    const key = storeThreadKey(remote.environmentId, remote.threadId);
    return threadById(key) ? key : null;
  };
  const title = () => formatSubagentDisplayTitle(agent().title);
  const open = () => { const id = threadId(); if (id) (props.onOpen ?? openThreadById)(id); };
  return (
    <View
      class="min-w-0 flex-row items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent-50 transition-colors duration-150 ease-in-out"
      onPress={threadId() ? open : undefined}
      accessibilityLabel={threadId() ? `Open ${title()}` : title()}
      role={threadId() ? "button" : "text"}
    >
      <SubagentAvatar agent={agent} status={status} />
      <View class="min-w-0 flex-1">
        <View class="min-w-0 flex-row items-baseline gap-2">
          <Text class="min-w-0 truncate text-xs font-medium text-foreground">{title()}</Text>
          {agent().remoteLabel ? <Text class="shrink-0 text-xs text-muted-foreground">{`on ${agent().remoteLabel}`}</Text> : null}
        </View>
        <Text class={`truncate text-2xs leading-relaxed ${failed() ? "text-destructive" : "text-muted-foreground"}`}>{detail() ?? statusLabel()}</Text>
      </View>
      {trailing() ? <Text class={`shrink-0 text-xs ${failed() ? "text-destructive" : "text-muted-foreground"}`}>{trailing()}</Text> : null}
      <Text class="shrink-0 text-xs tabular-nums text-muted-foreground">{event()?.timestamp ?? formatSubagentElapsed(agent(), props.now())}</Text>
      {threadId() ? <Icon name="chevron-right" size={14} /> : null}
      <SubagentHoverCard agent={agent} now={props.now} />
    </View>
  );
}

/** V2SubagentGroup (more than one child) or the bare row (one child). */
export function SubagentGroupRow(props: {
  id: string;
  agents: () => SubagentFields[];
  expandedActivity: () => Record<string, boolean>;
  onToggle: (id: string) => void;
  onOpen?: (threadId: string) => void;
}) {
  const groupId = () => `subagent-group:${props.id}`;
  const expanded = () => Boolean(props.expandedActivity()[groupId()]);
  const summary = () => subagentGroupSummary(props.agents());
  const now = useClock(() => props.agents().some((agent) => subagentActive(agent.status)));
  const label = () => subagentCountLabel(props.agents().length);
  const counts = () => summarizeSubagentStatuses(props.agents().map((agent) => agent.status));
  const bright = () => expanded() || summary().active;
  return (
    <View>
    {props.agents().length === 1 ? (
      <View class={`${lane()} py-0.5`}>
        <SubagentRow agent={() => props.agents()[0]} now={now} onOpen={props.onOpen} />
      </View>
    ) : (
    <View class={`${lane()} px-0.5`}>
      <View
        class={`min-w-0 flex-row items-center gap-2.5 py-2 pr-3.5 ${bright() ? "opacity-100" : "opacity-50 hover:opacity-100"} transition-opacity duration-150 ease-in-out`}
        onPress={() => props.onToggle(groupId())}
        accessibilityLabel={label()}
        accessibilityState={{ expanded: expanded() }}
        role="button"
      >
        <View class="shrink-0 flex-row items-center">
          <Each of={props.agents().slice(0, 3)} key={(agent) => agent.subagentId}>
            {(agent, index) => <SubagentAvatar agent={agent} overlap={index() > 0} />}
          </Each>
          {props.agents().length > 3 ? (
            <View class="-ms-1.5 size-6 shrink-0 items-center justify-center rounded-full border-2 border-background">
              <View class="size-6 items-center justify-center rounded-full bg-muted">
                <Text class="text-3xs font-medium text-muted-foreground">{`+${props.agents().length - 3}`}</Text>
              </View>
            </View>
          ) : null}
        </View>
        <View class="min-w-0 flex-1">
          <Text class={`text-xs font-semibold ${bright() ? "text-foreground" : "text-muted-foreground"}`}>{label()}</Text>
          <Text class={`truncate text-3xs ${summary().active ? "text-info" : summary().failed ? "text-destructive" : "text-muted-foreground"}`}>{counts()}</Text>
        </View>
        <Text class="shrink-0 text-xs tabular-nums text-muted-foreground">{formatSubagentElapsed(subagentGroupTiming(props.agents()), now())}</Text>
        <TimelineIcon name={expanded() ? "chevron-up" : "chevron-down"} size={14} />
      </View>
      {expanded() ? (
        <View class="mb-1 mt-1 rounded-lg border border-border-60 p-1" style={{ backgroundColor: tokenAlpha("card", 0.3) }}>
          <Each of={props.agents()} key={(agent) => agent.subagentId}>
            {(agent) => <SubagentRow agent={agent} now={now} onOpen={props.onOpen} />}
          </Each>
        </View>
      ) : null}
    </View>
    )}
    </View>
  );
}
