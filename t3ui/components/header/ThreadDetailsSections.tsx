// The thread details card's sections after the Version Control block (ThreadDetailsPanel.tsx):
// the Environment row, pull request rows, Servers, Automations, Lineage and Side chats.
// Rows follow ThreadDetailsPrRows.tsx, ThreadServersPanel.tsx, ThreadAutomationsPanel.tsx and
// ThreadRelationshipsControl.tsx; the rules are in detailsLogic.ts and lineageLogic.ts.
import { ORCHESTRATION_OPERATE_SCOPE, scopeAllows } from "../../backend/sessionScopes";
import { colorScheme, computed, platform, effect, openUrl, Scroll, signal, Text, untracked, View } from "nsh";
import { Menu, MenuItem, Switch, Tooltip } from "nsh/base";
import { canOperatePreview, canOperateThread } from "./sourceControlScope";
import { openScheduledTasks } from "./scheduledTaskRequest";
import { allThreads, archivedThreads, backendConnected, backendConnectionGeneration, liveThreadProjection, openThread, openThreadById, refreshArchivedThreads, requestBackend, subscribeBackend, threadFromShell } from "../../store";
import { readScheduledTasks, type ScheduledTask } from "../scheduled/data";
import { PRIcon } from "../pullRequest/PRIcon";
import { pullRequestListOrder, resolveCurrentLink } from "../sidebar/threadPullRequestStack";
import { resolveState, toneColor } from "../pullRequest/pullRequestPresentation";
import { openPullRequestSurface } from "../rightPanel/panelState";
import { openDiscoveredServer } from "../browser/previewOpeners";
import { ProviderIconView } from "../../pages/settings/providers/ui";
import { providerMetaFor } from "../composer/providerCatalog";
import {
  AUTOMATION_DOT, boundTasks, lockedWorkspaceLabel, MACHINE_ICON, otherPullRequests, pullRequestRowLabel, readDiscoveredServers,
  runContextLabel, serverCaption, serverKey, SERVER_PAGE_COUNT, serverTitle, showMoreLabel, taskScheduleLine, threadServers, workspaceMarkName,
  type DiscoveredServer, type EnvironmentDescriptor,
} from "./detailsLogic";
import {
  lineageModel, lineageTitle, projectionCanDetach, readContextTransfers, readProjectedSubagents, relationshipFailureToast, sideChatsTitle,
  type ContextTransfer, type LineageRow, type LineageThread, type ProjectedSubagent,
} from "./lineageLogic";
import { HIcon } from "./HeaderIcons";
import { ThreadDetailsPrRow } from "./ThreadDetailsPrRow";
import { watchCommand } from "../pullRequest/threadPullRequests.logic";
import { dispatchThreadCommand } from "../sidebar/threadActions";
import { errorToast } from "../toast/toastState";
import { DelegatedFromRow, LineageRowView, RemoteSubagentRow, type LineageContext } from "./LineageRows";
import { storeThreadKey } from "../../environments/machineMentions";
import { environmentConnections, environmentGeneration, parseScopedKey, refreshRemoteArchive, scopeShellRecord } from "../../environments/connectionManager";
import { familyRowStillPresent, familyShellGeneration } from "../../environments/familyRemovals";
import { isFinishedAgentStatus } from "./lineageLogic";
import { deriveWorkflowGroups, mergeBack as dispatchMergeBack, readMergeBack, readProjectedAgents, stopSubagent as dispatchStopSubagent, stopWorkflow as dispatchStopWorkflow, type MergeBackState, type ProjectedAgent } from "./workflowModel";
import type { Request, Subscribe } from "./gitRuntime";
import { retryingStream } from "../../environments/environmentSession";
import { showToast } from "../toast";
import { MENU_ITEM_ROW_CLASS } from "../menuStyles";
import type { LinkedPullRequest, ThreadLineage } from "./threadRelations";

// Last-known lists, kept across card opens so their rows show at once on the next open.
const lastServers = signal<DiscoveredServer[]>([]);
const lastTasks = signal<ScheduledTask[]>([]);
interface LineageProjection { subagents: ProjectedSubagent[]; agents: ProjectedAgent[]; transfers: ContextTransfer[]; mergeBack: MergeBackState; canDetach: boolean }
const lastProjections = new Map<string, LineageProjection>();
const lastTitles = signal<ReadonlyMap<string, string>>(new Map());

const rowClass = "min-h-8 w-full flex-row items-center gap-2.5 rounded-lg px-2.5 hover:bg-details-row-hover";
const labelClass = "min-w-0 flex-1 truncate text-[13px] font-medium text-details-label";
const menuClass = "min-w-[200px] rounded-lg border border-border bg-popover-84 p-1";

function Tip(props: { title: string; hint?: string }) {
  return (
    <Tooltip class="max-w-80 rounded-md border border-border bg-popover px-2 py-1">
      <Text class="text-xs font-medium text-popover-foreground">{props.title}</Text>
      {props.hint ? <Text class="text-xs text-muted-foreground">{props.hint}</Text> : null}
    </Tooltip>
  );
}

// --- sections ---------------------------------------------------------------------------------------

/** The card's sections, top to bottom. A divider only follows a section that has content. */
const SECTION_ORDER = ["workspace", "versionControl", "servers", "automations", "lineage", "sideChats", "usage", "context"] as const;
export type SectionId = (typeof SECTION_ORDER)[number];
const presentSections = signal<readonly string[]>([]);

function setPresent(id: string, present: boolean) {
  const current = untracked(presentSections);
  if (current.includes(id) === present) return;
  presentSections.set(present ? [...current, id] : current.filter((entry) => entry !== id));
}

/** Marks a section as rendered for as long as `present()` holds, so later sections draw their divider. */
export function useSectionPresence(id: SectionId, present: () => boolean) {
  effect(() => {
    setPresent(id, present());
    return () => { setPresent(id, false); };
  });
}

/** Whether a section above `id` is showing: the divider rule of ThreadDetailsSection. */
export function sectionSeparated(id: SectionId): boolean {
  const index = SECTION_ORDER.indexOf(id);
  const present = presentSections();
  return SECTION_ORDER.slice(0, index).some((entry) => present.includes(entry));
}

/** ThreadDetailsSection: `px-2 pt-2 pb-2.5`, a divider above and a muted `text-2xs` heading. */
export function DetailsSection(props: { id: SectionId; title: string; showHeading?: boolean; actions?: unknown; children: unknown }) {
  useSectionPresence(props.id, () => true);
  return (
    <View role="group" accessibilityLabel={props.title} class={`px-2 pb-2.5 pt-2 ${sectionSeparated(props.id) ? "border-t border-details-divider" : ""}`}>
      {props.showHeading === false ? null : (
        <View class="mb-1 min-h-8 flex-row items-center justify-between gap-2 px-2.5">
          <Text class="min-w-0 truncate text-2xs font-medium text-muted-foreground">{props.title}</Text>
          {props.actions ? <View class="shrink-0 flex-row items-center gap-1">{props.actions as never}</View> : null}
        </View>
      )}
      {props.children as never}
    </View>
  );
}

function ShowMore(props: { expanded: boolean; hidden: number; onPress: () => void; label?: string; plus?: boolean }) {
  return (
    <View role="button" accessibilityLabel={props.label ?? showMoreLabel(props.expanded, props.hidden)} onPress={props.onPress} class={rowClass}>
      <HIcon name={props.plus ? "plus" : props.expanded ? "chevron-up" : "chevron-down"} size={16} />
      <Text class={`min-w-0 flex-1 truncate text-sm font-medium ${props.plus ? "text-details-muted-70" : "text-muted-foreground"}`}>{props.label ?? showMoreLabel(props.expanded, props.hidden)}</Text>
    </View>
  );
}

// --- environment ---------------------------------------------------------------------------------

/**
 * BranchToolbar's locked run-context row in the panel: the machine's mark and name in muted text with the
 * workspace's mark trailing, so every row label starts on one edge. Without a known environment it
 * names the workspace ("Local checkout") with its mark in front.
 */
export function EnvironmentRow(props: { worktreePath: () => string | null | undefined; environment?: () => EnvironmentDescriptor | null }) {
  const workspace = () => lockedWorkspaceLabel(props.worktreePath());
  const environment = () => props.environment?.() ?? null;
  const mark = () => <HIcon name={workspaceMarkName(props.worktreePath())} size={16} />;
  return (
    <View role="group" accessibilityLabel={runContextLabel(workspace(), environment()?.label)} class="h-8 w-full min-w-0 flex-row items-center gap-2.5 rounded-lg px-2.5">
      {environment() ? <HIcon name={MACHINE_ICON[environment()!.machine] ?? "server"} size={18} /> : mark()}
      <Text class={`min-w-0 flex-1 truncate text-[13px] font-medium ${environment() ? "text-muted-foreground" : "text-details-label"}`}>{environment() ? environment()!.label : workspace()}</Text>
      {environment() ? mark() : null}
    </View>
  );
}

// --- pull requests ---------------------------------------------------------------------------------

function PrRow(props: { link: LinkedPullRequest; projectId: string }) {
  // ThreadDetailsPrRows: a watched link offers Stop watching (thread.pull-request.watch false).
  const stopWatching = () => {
    const threadId = openThread()?.id;
    if (!threadId) return;
    void dispatchThreadCommand(watchCommand(threadId, props.link, false)).catch((cause: unknown) => errorToast("Could not change watching", cause instanceof Error ? cause.message : undefined));
  };
  return <ThreadDetailsPrRow link={props.link} projectId={props.projectId} label={pullRequestRowLabel(props.link)} {...(props.link.watching ? { onStopWatching: stopWatching } : {})} />;
}

/** ThreadDetailsPrRows: the newest link, the others behind "Show N more". */
export function PullRequestRows(props: { links: () => readonly LinkedPullRequest[]; projectId: () => string }) {
  const expanded = signal(false);
  // ThreadDetailsPrRows: the current link (resolveThreadCurrentPullRequestLink), then the others in pullRequestListLines order.
  const badgeLinks = () => props.links().map((link) => ({ ...link, stack: (link as { stack?: unknown }).stack ?? null })) as never;
  const current = () => (resolveCurrentLink(badgeLinks()) as LinkedPullRequest | null) ?? props.links()[0] ?? null;
  const rest = () => otherPullRequests(pullRequestListOrder(badgeLinks()) as unknown as LinkedPullRequest[], current());
  return (
    <>
      {current() ? (
        <>
          <PrRow link={current()!} projectId={props.projectId()} />
          {expanded() ? <Each of={rest()} key={(link) => `${link.repository}#${link.number}`}>{(link) => <PrRow link={link()} projectId={props.projectId()} />}</Each> : null}
          {rest().length > 0 ? <ShowMore expanded={expanded()} hidden={rest().length} onPress={() => expanded.update((value) => !value)} /> : null}
        </>
      ) : null}
    </>
  );
}

// --- servers -----------------------------------------------------------------------------------

/** Local servers the thread's terminals and agent started. Hidden while none run. */
export function ThreadServers(props: { threadId: () => string | null; subscribe?: Subscribe; request?: Request; canStop?: () => boolean; canOpen?: () => boolean; openPreview?: (url: string) => void; openExternal?: (url: string) => unknown }) {
  const subscribe = props.subscribe ?? subscribeBackend;
  const request = props.request ?? requestBackend;
  const all = lastServers;
  const visibleCount = signal(SERVER_PAGE_COUNT);
  const stopping = signal<string | null>(null);
  // The last list stays while the card is closed, so the section is there on the first frame of the next open.
  effect(() => {
    backendConnected(); // a reconnect closes the stream: subscribe again
    // state/preview.ts discoveredLocalServers is a retried stream: an error or end resubscribes (250 ms .. 30 s).
    const stop = retryingStream(subscribe, "subscribeDiscoveredLocalServers", {}, (value) => all.set(readDiscoveredServers(value)));
    return () => { stop(); };
  });
  const servers = () => threadServers(all(), props.threadId());
  // A boolean, so the section is not rebuilt each time the list is replaced.
  const hasServers = computed(() => servers().length > 0);
  const hidden = () => Math.max(0, servers().length - visibleCount());
  // ThreadServersPanel: stopping needs the localServerStop capability (canStop) and terminal:operate (preview.stopLocalServer).
  const stoppable = (server: DiscoveredServer) => server.pid !== null && (props.canStop?.() ?? true) && scopeAllows("terminal:operate");
  const canOpenPreview = () => props.canOpen?.() ?? canOperatePreview();
  /** Opens the port in the browser panel; a modified press goes to the system browser, as a link does. */
  async function openServer(server: DiscoveredServer, modifiers?: { platform: boolean; control: boolean }) {
    if (modifiers?.platform || modifiers?.control) {
      try { await (props.openExternal ?? openUrl)(server.url); }
      catch (cause) { showToast({ type: "error", title: "Unable to open in browser", description: cause instanceof Error ? cause.message : String(cause) }); }
      return;
    }
    try { (props.openPreview ?? openDiscoveredServer)(server.url); }
    catch (cause) { showToast({ type: "error", title: "Unable to open preview", description: cause instanceof Error ? cause.message : String(cause) }); }
  }
  async function stop(server: DiscoveredServer) {
    if (server.pid === null || stopping() !== null) return;
    stopping.set(serverKey(server));
    try { await request("preview.stopLocalServer", { pid: server.pid, port: server.port }); }
    catch (cause) { showToast({ type: "error", title: "Could not stop server", description: cause instanceof Error ? cause.message : undefined }); }
    finally { stopping.set(null); }
  }
  return (
    <>
      {hasServers() ? (
        <DetailsSection id="servers" title="Servers">
          <Each of={servers().slice(0, visibleCount())} key={(server) => serverKey(server)}>
            {(server) => (
              <View class="relative flex-row items-center rounded-lg">
                <View role="button" accessibilityLabel={serverTitle(server())} tooltip={<Tip title="Open in the browser panel." hint={`${platform.os === "macos" ? "\u2318-click" : "Ctrl-click"} for your browser.`} />} disabled={!canOpenPreview()} onPress={(event) => void openServer(server(), event?.modifiers)} class={`${rowClass} flex-1 ${canOpenPreview() ? "" : "opacity-64"}`}>
                  <HIcon name="globe" size={16} />
                  <View class={`min-w-0 flex-1 gap-0.5 ${stoppable(server()) ? "pr-6" : ""}`}>
                    <Text class="truncate text-sm font-medium leading-4 text-details-title">{serverTitle(server())}</Text>
                    <Text class="truncate text-2xs font-normal leading-4 text-muted-foreground">{serverCaption(server())}</Text>
                  </View>
                </View>
                {stoppable(server()) ? (
                  <View role="button" accessibilityLabel={`Stop ${serverTitle(server())}`} tooltip={<Tip title="Stop server" />} disabled={stopping() !== null} onPress={() => void stop(server())} class="absolute right-1 size-6 items-center justify-center rounded-md hover:bg-details-row-hover active:scale-[0.97] transition-transform duration-150 ease-in-out">
                    <HIcon name={stopping() === serverKey(server()) ? "loader-circle" : "square"} size={12} />
                  </View>
                ) : null}
              </View>
            )}
          </Each>
          {servers().length > SERVER_PAGE_COUNT ? (
            <ShowMore expanded={hidden() === 0} hidden={hidden()} label={hidden() > 0 ? `Show ${Math.min(hidden(), SERVER_PAGE_COUNT)} more` : "Show less"} onPress={() => visibleCount.set(hidden() > 0 ? visibleCount() + SERVER_PAGE_COUNT : SERVER_PAGE_COUNT)} />
          ) : null}
        </DetailsSection>
      ) : null}
    </>
  );
}

// --- automations ---------------------------------------------------------------------------------

export function ThreadAutomations(props: { threadId: () => string | null; subscribe?: Subscribe; request?: Request; now?: () => number; canOperate?: () => boolean; onOpenTasks?: (taskId: string | null) => void }) {
  const subscribe = props.subscribe ?? subscribeBackend;
  const request = props.request ?? requestBackend;
  const tasks = lastTasks;
  const busy = signal<string | null>(null);
  // `tasksQuery.error`: shown with the section even when no task is bound.
  const loadError = signal<string | null>(null);
  effect(() => {
    backendConnected(); // a reconnect closes the stream: subscribe again
    untracked(() => loadError.set(null));
    const stop = subscribe("scheduledTasks.subscribe", {}, (value) => { try { tasks.set(readScheduledTasks(value)); loadError.set(null); } catch { /* an unreadable list shows nothing */ } }, (error) => loadError.set(error.message));
    return () => { stop(); };
  });
  const bound = () => boundTasks(tasks(), props.threadId());
  const showSection = computed(() => bound().length > 0 || loadError() !== null);
  const canOperate = () => props.canOperate?.() ?? canOperateThread();
  const openTasks = (taskId: string | null) => (props.onOpenTasks ?? openScheduledTasks)(taskId);
  async function run(method: string, task: ScheduledTask, payload: Record<string, unknown>, failure: string) {
    if (busy() !== null || !canOperate()) return;
    busy.set(task.id);
    try { await request(method, payload); }
    catch (cause) { showToast({ type: "error", title: failure, description: cause instanceof Error ? cause.message : String(cause) }); }
    finally { busy.set(null); }
  }
  const iconButton = "size-7 items-center justify-center rounded-md hover:bg-details-row-hover active:scale-[0.97] transition-transform duration-150 ease-in-out";
  return (
    <>
      {showSection() ? (
        <DetailsSection
          id="automations"
          title="Automations"
          actions={
            <View role="button" accessibilityLabel="Manage scheduled tasks" tooltip={<Tip title="Manage scheduled tasks" />} onPress={() => openTasks(null)} class={iconButton}>
              <HIcon name="settings-2" size={14} />
            </View>
          }
        >
          <Scroll style={{ maxHeight: 216 }}>
            <Each of={bound()} key={(task) => task.id}>
              {(task) => (
                <View class={`${rowClass} py-1.5`} accessibilityLabel={task().title}>
                  <View class="size-4 shrink-0 items-center justify-center">
                    <HIcon name="calendar-clock" size={16} />
                    <View class={`absolute -right-1 -top-1 size-1.5 rounded-full ${AUTOMATION_DOT[task().lastRunStatus] ?? AUTOMATION_DOT.never}`} />
                  </View>
                  <View class="min-w-0 flex-1" tooltip={<Tip title={task().title} hint={taskScheduleLine(task(), props.now?.() ?? Date.now())} />}>
                    <Text class="truncate text-sm font-medium text-details-title">{task().title}</Text>
                    <Text class="truncate text-2xs text-muted-foreground">{taskScheduleLine(task(), props.now?.() ?? Date.now())}</Text>
                  </View>
                  <View role="button" accessibilityLabel={`Edit ${task().title}`} tooltip={<Tip title="Edit automation" />} onPress={() => openTasks(task().id)} class={iconButton}>
                    <HIcon name="pencil" size={14} />
                  </View>
                  {/* Webhook tasks need a request from their URL. */}
                  {task().schedule.type === "webhook" ? null : (
                    <View
                      role="button"
                      accessibilityLabel={`Run ${task().title} now`}
                      tooltip={<Tip title="Run now" />}
                      disabled={!canOperate() || busy() !== null || task().lastRunStatus === "running"}
                      onPress={() => void run("scheduledTasks.runNow", task(), { id: task().id }, "Could not run automation")}
                      class={`${iconButton} ${!canOperate() || busy() !== null || task().lastRunStatus === "running" ? "opacity-64" : ""}`}
                    >
                      <HIcon name="play" size={14} />
                    </View>
                  )}
                  <Switch
                    accessibilityLabel={task().enabled ? `Pause ${task().title}` : `Resume ${task().title}`}
                    checked={task().enabled}
                    disabled={!canOperate() || busy() !== null}
                    onChange={(event: { checked?: boolean; value?: boolean }) => void run("scheduledTasks.setEnabled", task(), { id: task().id, enabled: Boolean(event?.checked ?? event?.value ?? !task().enabled) }, "Could not update automation")}
                    class="h-[18px] w-[30px] items-center"
                    trackClass="h-[18px] w-[30px] justify-center rounded-full p-[2px] bg-input checked:bg-primary transition-colors duration-200 ease-in-out"
                    thumbClass="size-3.5 rounded-full bg-background checked:translate-x-3 transition-transform duration-150 ease-in-out"
                  />
                </View>
              )}
            </Each>
          </Scroll>
          {/* Kept last: the details card treats a section whose last child is empty as empty. */}
          {loadError() !== null ? <Text class="px-2.5 py-1.5 text-2xs text-destructive-foreground">{`Could not load automations: ${loadError()}`}</Text> : null}
        </DetailsSection>
      ) : null}
    </>
  );
}

// --- lineage and side chats ------------------------------------------------------------------------

const LINEAGE_INITIAL_COUNT = 6;
const LINEAGE_PAGE_COUNT = 12;

/** ThreadLineageGroup: the rows (six, then twelve more), or the collapsible "Previous agents" group. */
function RelationGroup(props: { label: string | null; rows: () => LineageRow[]; expanded: boolean; ctx: LineageContext; /** Tasks delegated to linked environments, listed with the group's rows (LineageRow { remote }). */ remote?: () => ProjectedAgent[]; renderRemote?: (agent: ProjectedAgent) => ReturnType<typeof RemoteSubagentRow> }) {
  const expanded = signal(props.expanded);
  const visible = signal(LINEAGE_INITIAL_COUNT);
  type Entry = { key: string; row?: LineageRow; remote?: ProjectedAgent };
  const entries = (): Entry[] => [...props.rows().map((row) => ({ key: row.threadId, row })), ...(props.remote?.() ?? []).map((agent) => ({ key: `remote:${agent.id}`, remote: agent }))];
  const shown = () => entries().slice(0, visible());
  const hiddenCount = () => entries().length - shown().length;
  const failedCount = () => props.rows().filter((row) => row.status === "failed" || row.status === "error").length + (props.remote?.() ?? []).filter((agent) => agent.status === "failed").length;
  const hasRows = computed(() => entries().length > 0);
  return (
    <>
      {hasRows() ? (
        <View>
          {props.label ? (
            <View role="button" accessibilityLabel={props.label} onPress={() => expanded.update((value) => !value)} class={`${rowClass} h-8`}>
              <HIcon name="bot" size={16} />
              <Text class={labelClass}>{props.label}</Text>
              {failedCount() > 0 ? <Text class="shrink-0 text-2xs text-destructive">{`${failedCount()} failed`}</Text> : null}
              {expanded() ? null : <Text class="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">{`${entries().length}`}</Text>}
              <HIcon name={expanded() ? "chevron-down" : "chevron-right"} size={16} />
            </View>
          ) : null}
          {expanded() ? (
            <>
              <Each of={shown()} key={(entry) => entry.key}>{(entry) => entry().row ? <LineageRowView row={entry().row!} ctx={props.ctx} /> : props.renderRemote?.(entry().remote!) ?? null}</Each>
              {hiddenCount() > 0 ? <ShowMore plus expanded={false} hidden={hiddenCount()} label={`Show ${Math.min(hiddenCount(), LINEAGE_PAGE_COUNT)} more`} onPress={() => visible.update((count) => count + LINEAGE_PAGE_COUNT)} /> : null}
            </>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

function toLineageThread(thread: ReturnType<typeof allThreads>[number]): LineageThread {
  const meta = thread.meta;
  return {
    id: thread.id, title: thread.title, lineage: thread.relations?.lineage, forkSourceThreadId: thread.relations?.forkSourceThreadId,
    status: meta?.runStatus ?? null, activityRunStatus: meta?.activityRunStatus ?? null, providerInstanceId: meta?.providerInstanceId ?? null,
    createdAt: thread.createdAt ?? null, startedAt: meta?.latestRunStartedAt ?? null, completedAt: meta?.latestRunCompletedAt ?? null, hasRun: Boolean(meta?.latestRunId),
  };
}

export function ThreadRelationships(props: {
  threads?: (() => readonly LineageThread[]) | undefined;
  thread: () => { id: string; lineage?: ThreadLineage | undefined; forkSourceThreadId?: string | undefined; delegatedFrom?: { environmentId: string; threadId: string; title: string } | undefined; linkOrigin?: string | null | undefined } | null;
  showLineage: () => boolean;
  showSideChats: () => boolean;
  request?: Request;
  now?: () => number;
}) {
  const request = props.request ?? requestBackend;
  const projection = signal<LineageProjection | null>(null);
  const rowBusy = signal<string | null>(null);
  const clock = signal(Date.now());
  const now = props.now ?? (() => clock());
  const busy = signal(false);
  const family = signal<{ environment: string; sequence: number; rows: readonly LineageThread[] }>({ environment: "", sequence: 0, rows: [] });
  const delegatedFrom = () => props.thread()?.delegatedFrom ?? null;
  const threads = () => {
    const held = family();
    return [...(props.threads ? [...props.threads()] : [...allThreads(), ...archivedThreads()].map(toLineageThread)),
      ...held.rows.filter((thread) => familyRowStillPresent(held.environment, parseScopedKey(thread.id)?.localId ?? thread.id, held.sequence))];
  };
  const model = () => {
    const current = props.thread();
    if (!current) return null;
    return lineageModel({
      current, threads: threads(), subagents: projection()?.subagents ?? [], workflowStatuses: new Map((projection()?.agents ?? []).flatMap((agent) => agent.workflow && agent.childThreadId ? [[agent.childThreadId, agent.status] as const] : [])), transfers: projection()?.transfers ?? [], remoteStatuses: (projection()?.agents ?? []).filter((agent) => agent.remoteChild).map((agent) => agent.status), resolvedTitles: lastTitles(), mergeTargetThreadId: projection()?.mergeBack.targetThreadId ?? null, canDetach: projection()?.canDetach ?? false, delegatedFrom: Boolean(delegatedFrom()),
      showLineage: props.showLineage(), showSideChats: props.showSideChats(),
    });
  };

  // Depend on the thread identity and connection, not the changing shell record: streaming updates
  // must not clear the family rows or issue another request for the same thread.
  const familyScope = computed(() => {
    const id = props.thread()?.id;
    if (!id || (!props.showLineage() && !props.showSideChats())) return null;
    const scoped = parseScopedKey(id);
    const connected = scoped ? environmentConnections()[scoped.environmentId]?.phase === "connected" : backendConnected();
    if (!props.request && !connected) return null;
    return JSON.stringify([id, scoped ? environmentGeneration(scoped.environmentId) : backendConnectionGeneration(), familyShellGeneration(scoped?.environmentId ?? "")]);
  });
  let requestedFamilyScope: string | null | undefined;
  let familyRequestVersion = 0;
  let familyMounted = true;
  effect(() => () => { familyMounted = false; familyRequestVersion += 1; });
  // The shell can omit idle children and older settled threads; T3 loads the selected thread's family separately.
  effect(() => {
    const scope = familyScope();
    if (scope === requestedFamilyScope) return;
    requestedFamilyScope = scope;
    const requestVersion = ++familyRequestVersion;
    if (!scope) { family.set({ environment: "", sequence: 0, rows: [] }); return; }
    const id = untracked(() => props.thread()?.id);
    if (!id) return;
    const scoped = parseScopedKey(id);
    family.set({ environment: scoped?.environmentId ?? "", sequence: 0, rows: [] });
    void request("orchestration.getThreadFamily", { threadId: id }).then((value) => {
      if (!familyMounted || requestVersion !== familyRequestVersion || typeof value !== "object" || value === null) return;
      const result = value as Record<string, unknown>;
      const rows = result.threads;
      if (!Array.isArray(rows)) return;
      const members = rows.flatMap((row): LineageThread[] => {
        if (typeof row !== "object" || row === null || Array.isArray(row)) return [];
        const shell = row as Record<string, unknown>;
        const thread = threadFromShell(scoped ? scopeShellRecord(scoped.environmentId, shell) : shell);
        return thread ? [toLineageThread(thread)] : [];
      });
      family.set({ environment: scoped?.environmentId ?? "", sequence: typeof result.snapshotSequence === "number" ? result.snapshotSequence : 0, rows: members });
    }).catch(() => {});
  });

  // The lineage graph includes archived shells too. Load them for this connection when the panel needs them,
  // even if the Archive settings page has never been opened.
  let archiveGeneration = "";
  effect(() => {
    if (props.threads || props.request || (!props.showLineage() && !props.showSideChats())) return;
    const id = props.thread()?.id;
    if (!id) return;
    const scoped = parseScopedKey(id);
    if (scoped) {
      const connection = environmentConnections()[scoped.environmentId];
      if (connection?.phase !== "connected") { archiveGeneration = ""; return; }
      const generation = `${scoped.environmentId}:${environmentGeneration(scoped.environmentId)}`;
      if (archiveGeneration === generation) return;
      archiveGeneration = generation;
      void refreshRemoteArchive(scoped.environmentId).catch(() => { if (archiveGeneration === generation) archiveGeneration = ""; });
      return;
    }
    if (!backendConnected()) { archiveGeneration = ""; return; }
    const generation = `primary:${backendConnectionGeneration()}`;
    if (archiveGeneration === generation) return;
    archiveGeneration = generation;
    void refreshArchivedThreads();
  });

  // The projection: running subagents without a thread, the children the shells leave out, and whether a session can detach.
  effect(() => {
    const id = props.thread()?.id;
    if (!id || (!props.showLineage() && !props.showSideChats())) return;
    // The open thread's subscription already delivers its projection (the reference reads its thread state, it
    // never polls): read it from the store. Only a thread with no live detail yet is fetched below.
    const streamed = props.request ? null : liveThreadProjection(id);
    if (streamed) {
      const next: LineageProjection = { subagents: readProjectedSubagents(streamed), agents: readProjectedAgents(streamed), transfers: readContextTransfers(streamed), mergeBack: readMergeBack(streamed), canDetach: projectionCanDetach(streamed) };
      lastProjections.set(id, next);
      projection.set(next);
      return;
    }
    projection.set(lastProjections.get(id) ?? null);
    let live = true;
    // The reference never polls the projection: one read until the thread's stream delivers it (liveThreadProjection
    // re-runs this effect when it does).
    void request("orchestration.getThreadProjection", { threadId: id }).then((value) => {
      const next: LineageProjection = { subagents: readProjectedSubagents(value), agents: readProjectedAgents(value), transfers: readContextTransfers(value), mergeBack: readMergeBack(value), canDetach: projectionCanDetach(value) };
      lastProjections.set(id, next);
      if (live) projection.set(next);
    }).catch(() => {});
    return () => { live = false; };
  });
  // Resolve unloaded parents and transfer endpoints; missing titles represent deleted threads.
  effect(() => {
    const current = props.thread();
    if (!current) return;
    const parentId = current?.forkSourceThreadId ?? current?.lineage?.parentThreadId;
    const ids = [parentId, ...(projection()?.transfers ?? []).flatMap((transfer) =>
      transfer.sourceThreadId === current.id && transfer.targetThreadId !== current.id ? [transfer.targetThreadId]
        : transfer.targetThreadId === current.id && transfer.sourceThreadId !== current.id ? [transfer.sourceThreadId] : [])]
      .filter((id): id is string => Boolean(id));
    const known = new Set(threads().map((thread) => thread.id));
    const missing = [...new Set(ids)].filter((id) => !known.has(id) && !untracked(lastTitles).has(id));
    if (missing.length === 0) return;
    let live = true;
    void request("orchestration.getThreadTitles", { threadIds: missing }).then((value) => {
      if (!live) return;
      const titles = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
      const resolved = missing.flatMap((id): [string, string][] => {
        const localId = parseScopedKey(id)?.localId;
        const title = titles[id] ?? (localId ? titles[localId] : undefined);
        return typeof title === "string" ? [[id, title]] : [];
      });
      if (resolved.length) lastTitles.set(new Map([...untracked(lastTitles), ...resolved]));
    }).catch(() => {});
    return () => { live = false; };
  });
  effect(() => {
    if (props.now || (model()?.active.length ?? 0) === 0) return;
    const timer = setInterval(() => clock.set(Date.now()), 1000);
    return () => clearInterval(timer);
  });

  async function disconnect() {
    const id = props.thread()?.id;
    if (!id || busy()) return;
    busy.set(true);
    try {
      const value = await request("orchestration.getThreadProjection", { threadId: id });
      const sessions = typeof value === "object" && value !== null && Array.isArray((value as Record<string, unknown>).providerSessions) ? ((value as Record<string, unknown>).providerSessions as unknown[]) : [];
      const commandId = `cmd:${crypto.randomUUID()}`;
      for (const session of sessions) {
        const sessionId = typeof session === "object" && session !== null ? (session as Record<string, unknown>).id : null;
        if (typeof sessionId !== "string") continue;
        await request("orchestration.dispatchCommand", { type: "provider-session.detach", commandId: `${commandId}:detach:${sessionId}`, threadId: id, providerSessionId: sessionId, reason: "client-requested" });
      }
    } catch (cause) { showToast({ type: "error", title: "Could not disconnect agent session", description: cause instanceof Error ? cause.message : undefined }); }
    finally { busy.set(false); }
  }

  // The rows' lookups and actions (renderRelationshipRow's merge, stop subagent and stop workflow).
  const workflows = computed(() => new Map(deriveWorkflowGroups(projection()?.agents ?? []).map((group) => [group.agent.id, group] as const)));
  // Tasks delegated to linked environments (remoteChild): opened through this app's connection to that machine.
  const remoteAgents = () => (projection()?.agents ?? []).filter((agent) => agent.remoteChild);
  const renderRemote = (agent: ProjectedAgent) => <RemoteSubagentRow agent={agent} openKey={remoteOpenKey(agent)} onOpen={openThreadById} />;
  const remoteOpenKey = (agent: { remoteChild?: { environmentId: string; threadId: string } | null }) => {
    const child = agent.remoteChild;
    if (!child) return null;
    const key = storeThreadKey(child.environmentId, child.threadId);
    return threads().some((thread) => thread.id === key) ? key : null;
  };
  const agentByThread = () => new Map((projection()?.agents ?? []).flatMap((agent) => (agent.childThreadId ? [[agent.childThreadId, agent] as const] : [])));
  const mergeTarget = () => projection()?.mergeBack ?? { targetThreadId: null, latestRunId: null };
  const parentTitle = () => { const id = mergeTarget().targetThreadId; return id ? threads().find((thread) => thread.id === id)?.title ?? lastTitles().get(id) ?? null : null; };
  async function merge() {
    const current = props.thread();
    const { targetThreadId, latestRunId } = mergeTarget();
    if (!current || !targetThreadId || !latestRunId || rowBusy() !== null) return;
    rowBusy.set("merge");
    try { await dispatchMergeBack({ sourceThreadId: current.id, targetThreadId, runId: latestRunId }, request); openThreadById(targetThreadId); }
    catch { showToast(relationshipFailureToast("Could not merge back")); }
    finally { rowBusy.set(null); }
  }
  async function stopRow(key: string, run: () => Promise<unknown>, failure: string) {
    if (rowBusy() !== null) return;
    rowBusy.set(key);
    try { await run(); }
    catch { showToast(relationshipFailureToast(failure)); }
    finally { rowBusy.set(null); }
  }
  const lineageContext: LineageContext = {
    now, agentFor: (threadId) => agentByThread().get(threadId), workflowFor: (agentId) => workflows().get(agentId), mergeBack: mergeTarget, parentTitle,
    canOperate: () => scopeAllows(ORCHESTRATION_OPERATE_SCOPE), busy: () => rowBusy(), onMerge: () => void merge(),
    onStopSubagent: (agent) => void stopRow(agent.childThreadId ?? agent.id, () => dispatchStopSubagent(agent, request), "Could not stop subagent"),
    onStopWorkflow: (agent) => void stopRow(agent.id, () => dispatchStopWorkflow({ threadId: props.thread()?.id ?? agent.threadId, subagentId: agent.id }, request), "Could not stop workflow"),
  };

  // Booleans, so the sections keep their state (a group left open) while the projection refreshes.
  const lineageShown = computed(() => model()?.showLineage === true);
  const sideChatsShown = computed(() => model()?.showSideChats === true);
  const lineageActions = () => (model()?.showLineage && projection()?.canDetach ? (
    <Menu
      popupClass={`${menuClass} min-w-60`}
      align="end"
      trigger={<View role="button" accessibilityLabel="More thread actions" disabled={busy()} class="size-6 items-center justify-center rounded-md hover:bg-details-row-hover active:scale-[0.97] transition-transform duration-150 ease-in-out"><HIcon name="ellipsis" size={14} /></View>}
    >
      <MenuItem accessibilityLabel="Disconnect agent session" class={MENU_ITEM_ROW_CLASS} onSelect={() => void disconnect()}>
        <HIcon name="unplug" size={14} />
        <Text class="text-sm text-popover-foreground">Disconnect agent session</Text>
      </MenuItem>
    </Menu>
  ) : null);

  return (
    <>
      {lineageShown() ? (
        <DetailsSection id="lineage" title={lineageTitle(model()!.runningCount)} showHeading={model()!.showLineageHeading} actions={lineageActions()}>
          {delegatedFrom() ? <DelegatedFromRow delegatedFrom={delegatedFrom()!} fallbackLabel={props.thread()?.linkOrigin} /> : null}
          <RelationGroup label={null} rows={() => model()?.related ?? []} expanded ctx={lineageContext} />
          <RelationGroup label={null} rows={() => model()?.active ?? []} expanded ctx={lineageContext} remote={() => remoteAgents().filter((agent) => !isFinishedAgentStatus(agent.status))} renderRemote={renderRemote} />
          <RelationGroup label="Previous agents" rows={() => model()?.previous ?? []} expanded={false} ctx={lineageContext} remote={() => remoteAgents().filter((agent) => isFinishedAgentStatus(agent.status))} renderRemote={renderRemote} />
        </DetailsSection>
      ) : null}
      {sideChatsShown() ? (
        <DetailsSection id="sideChats" title={sideChatsTitle(model()!.runningSideChats)}>
          <RelationGroup label={null} rows={() => model()?.sideChats ?? []} expanded ctx={lineageContext} />
        </DetailsSection>
      ) : null}
    </>
  );
}
