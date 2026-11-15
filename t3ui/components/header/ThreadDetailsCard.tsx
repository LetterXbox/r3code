// The thread details card (ThreadDetailsPanel.tsx): Open in, then Version
// Control with the Git actions quick action and its dropdown, and the Changes
// row with its +/- totals. In the web it is a popover under the header; here it
// is an Overlay anchored to the header. Server calls go through `subscribe` and
// `request`, which tests replace.
import { FadeScroll } from "../FadeScroll";
import { visibleThreadPullRequests } from "../pullRequest/threadPullRequests.logic";
import { threadFindOpen } from "../thread/threadFindState";
import { ORCHESTRATION_OPERATE_SCOPE, scopeAllows } from "../../backend/sessionScopes";
import { announce, cleanup, Clipboard, computed, effect, openUrl, Overlay, platform, Scroll, signal, Storage, Text, untracked, View, windowSize } from "nsh";
import type { ViewRef } from "nsh";
import { createFocusTargets, noteFocusArea, registerFocusArea } from "../../commands/workspaceFocus";
import { Menu as PopupMenu } from "nsh/desktop";
import { Menu, MenuItem, MenuSeparator, Select, Tooltip } from "nsh/base";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { chatCanvasSize, THREAD_DETAILS_CARD_GAP, threadDetailsDocks } from "../thread/chatLane";
import { allProjects, allThreads, backendConnected, backendStatus, backendUrl, configureBackend, isSending, isServerThread, openSettings, openThread, requestBackend, setWorkspaceStrategy, subscribeBackend, workspaceStrategy } from "../../store";
import { BranchSelector, type BranchChange } from "../thread/BranchSelector";
import { branchActionFailureTitle } from "../thread/branchLogic";
import { RunContextRow } from "./RunContextRow";
import { buildEnvironmentOptions } from "../thread/environmentOptions";
import { loadSavedEnvironments, savedEnvironments } from "../../pages/settings/environments/savedEnvironments";
import { parseWorkspaceRefs, resolvePreviousWorktreeSeed } from "../thread/workspaceRefs";
import { serverEnvironment as serverEnvironmentSignal } from "../../pages/settings/settingsState";
import { CommitDialog, type CommitRequest } from "./CommitDialog";
import { DefaultBranchDialog } from "./DefaultBranchDialog";
import { PublishRepositoryDialog } from "./PublishRepositoryDialog";
import { behindUpstreamNote, canPublishRepository, inlineSuccessFor, quickActionDisabledReason, quietEmptyDraft, resolveDefaultBranchGate, SOURCE_CONTROL_READ_ONLY, type DefaultBranchGate } from "./gitActionLogic";
import { canOperateThread, canWriteSourceControl, loadSourceControlScopes } from "./sourceControlScope";
import { ProjectScriptsRow } from "./ProjectScriptsRow";
import { readT3ProjectScripts, type T3ProjectFileScript } from "./t3ProjectFile";
import { runProjectScript, saveProjectScripts } from "./projectScriptRun";
import type { ProjectScript } from "./projectScripts";
import { isDefaultThreadDetailsVisibility, resetThreadDetailsItems, setThreadDetailsItemVisible, THREAD_DETAILS_ITEMS, threadDetailsVisibility } from "./threadDetailsItems";
import {
  branchOptions, buildMenuItems, changeRequestIconName, changeRequestTerms, formatDiffCount, localBranchName, menuItemDisabledReason, resolveChangesTotals, quickActionIconName, resolveQuickAction, type GitActionMenuItem, type VcsStatus,
} from "./gitLogic";
import { diffAdditionClass, diffDeletionClass } from "../diff/diffColorScheme";
import { listRefs, runGitAction, runPull, switchRef, watchVcsStatus, type GitProgress, type Request, type Subscribe } from "./gitRuntime";
import { markRemoteOpenHintSeen, openThreadFolderInEditor, remoteOpenHintSeen, threadEnvironmentLabel, threadRemoteOpenState } from "./remoteOpen.runtime";
import { readEnvironmentDescriptor, type EnvironmentDescriptor } from "./detailsLogic";
import type { LineageThread } from "./lineageLogic";
import type { ThreadRelations } from "./threadRelations";
import { serverSettings } from "../../pages/settings/settingsState";
import { resolveProjectScripts } from "./scriptSettings";
import { EnvironmentRow, PullRequestRows, ThreadAutomations, ThreadRelationships, ThreadServers, useSectionPresence } from "./ThreadDetailsSections";
import { MENU_ITEM_ROW_CLASS, MENU_SEPARATOR_CLASS } from "../menuStyles";
import { EditorIcon } from "./EditorIcons";
import { ThreadDetailsContext, ThreadDetailsUsage } from "./ThreadDetailsUsage";
import { providerUsageLimits } from "../composer/providerCatalog";
import { latestTokenUsage, providerState, type TokenUsage } from "../composer/threadProviderState";
import type { LimitsView } from "../composer/usageLimitsLogic";
import { HIcon } from "./HeaderIcons";
import { showToast } from "../toast";
import { lastInvokedScriptId } from "./lastInvokedScript";
import { recordDetailsMeasurement, resolveThreadDetailsCardDensity } from "./threadDetailsDensity";
import { editorLabel, effectiveEditor, openInButtonLabel, readAvailableEditors, resolveOpenInOptions, shouldShowOpenInPicker } from "./openInLogic";
import { registerOpenFavoriteTarget } from "./openFavorite";
import { currentWorkspace, detailsPanelKey, openSurfaceAction, panelStateFor, toggleDetailsAction } from "../rightPanel/panelState";
import { enterStyle } from "../motion/Motion";
import { gitOutputReveal } from "../motion/motionTokens";
import { GIT_ACTION_SUCCESS_VISIBLE_MS, resolveFeatureBranchUnavailableReason } from "./gitActionLogic";

interface ActionExtra { commitMessage?: string; filePaths?: string[]; featureBranch?: boolean }
const rowClass = "h-8 w-full flex-row items-center gap-2.5 rounded-lg px-2.5 hover:bg-details-row-hover";
const labelClass = "min-w-0 flex-1 truncate text-[13px] font-medium text-details-label";
const menuClass = "min-w-[200px] rounded-lg border border-border bg-popover-84 p-1";
const itemClass = MENU_ITEM_ROW_CLASS;
const splitButtonClass = "size-8 items-center justify-center rounded-lg hover:bg-details-row-hover active:scale-[0.97] transition-transform duration-150 ease-in-out";
const lastEditor = signal<string | null>(null);
// Last-known values, kept across card opens so the card opens complete in one frame
// (the web keeps them in its query cache): VCS status and branches per folder, editors once.
const statusCache = new Map<string, VcsStatus>();
const branchCache = new Map<string, ReturnType<typeof branchOptions>>();
const editorsCache = signal<string[] | null>(null);
// The server's own description (its machine's name and kind, and whether it can stop local servers), read once.
const environmentCache = signal<{ descriptor: EnvironmentDescriptor | null; localServerStop: boolean } | null>(null);

void Storage.getItem("lastEditor").then((value) => { if (value && lastEditor() === null) lastEditor.set(value); }).catch(() => {});

function Tip(props: { text: string }) {
  return <Tooltip class="max-w-80 rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">{props.text}</Text></Tooltip>;
}

/** GitActionsControl's changesBaseLabel ("vs main" / "Uncommitted"), shown as the Changes row's
 * tooltip: inline, at the card's 280pt width, wide totals squeeze it to a bare ellipsis. */
export function changesBaseLabel(totals: { baseRef: string | null } | null): string | null {
  return totals ? (totals.baseRef === null ? "Uncommitted" : `vs ${totals.baseRef}`) : null;
}

/** `environment.capabilities.localServerStop`: only then does a server row offer Stop. */
function localServerStopSupported(config: unknown): boolean {
  const environment = typeof config === "object" && config !== null ? (config as Record<string, unknown>).environment : null;
  const capabilities = typeof environment === "object" && environment !== null ? (environment as Record<string, unknown>).capabilities : null;
  return typeof capabilities === "object" && capabilities !== null && (capabilities as Record<string, unknown>).localServerStop === true;
}

function elapsed(startedAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export interface ThreadDetailsCardProps {
  open?: () => boolean;
  cwd?: () => string | null;
  threadId?: () => string | null;
  /** Whether the thread has not been sent yet; defaults to the open thread being no server thread. */
  isDraft?: () => boolean;
  /** The thread the card describes; defaults to the open thread. */
  thread?: () => { id: string; title: string; path?: string | undefined; projectId?: string; relations?: ThreadRelations | undefined } | null | undefined;
  /** The threads lineage rows are looked up in; default to the store's. */
  threads?: () => readonly LineageThread[];
  anchor?: () => ViewRef | null;
  onClose?: () => void;
  onOpenChanges?: () => void;
  subscribe?: Subscribe;
  request?: Request;
  /** The project's scripts, the project's id (to save them) and how a script runs; default to the open thread's project and the terminal drawer. */
  scripts?: () => ProjectScript[] | null;
  projectId?: () => string | null;
  onRunScript?: (script: ProjectScript) => void;
  /** The selected provider's usage limits and the thread's context window; default to the composer's. */
  limits?: () => LimitsView | null;
  contextUsage?: () => TokenUsage | null;
}

/** ThreadFindBar THREAD_FIND_BAR_RESERVED_HEIGHT: the docked card moves below an open find bar (36 + the card gap). */
const THREAD_FIND_BAR_RESERVED_HEIGHT = 36 + 12;

export function ThreadDetailsCard(props: ThreadDetailsCardProps) {
  const thread = props.thread ?? (() => openThread());
  /** A thread that has not been sent yet: the card hosts its workspace pickers and hides what only a started thread has. */
  const isDraft = props.isDraft ?? (() => {
    // A host that names the folder or the thread itself (a test) says what the thread is; the store decides otherwise.
    if (props.cwd !== undefined || props.threadId !== undefined) return false;
    const current = thread();
    return current ? !isServerThread(current.id) : false;
  });
  const subscribe = props.subscribe ?? subscribeBackend;
  const request = props.request ?? requestBackend;
  const open = props.open ?? (() => panelStateFor(detailsPanelKey()).detailsOpen);
  // workspaceFocus "details": the card's first control still drawn takes the keyboard (requestWorkspaceFocus({ area: "details" })).
  const focusTargets = createFocusTargets();
  if (props.thread === undefined) cleanup(registerFocusArea({ id: "details", focus: () => { void focusTargets.focusFirst(); }, available: () => open() }));
  // Declared before draftCwd: the cwd computed below runs eagerly and reads it.
  const project = () => allProjects().find((item) => item.id === thread()?.projectId);
  // A draft has no server workspace yet: its folder is its project's, or the worktree it chose to continue in.
  const draftCwd = () => {
    const strategy = workspaceStrategy();
    return strategy.type === "existing_worktree" ? strategy.worktreePath : project()?.path ?? null;
  };
  // A computed string, so the status stream below resubscribes only when the folder changes, not on every shell push.
  const cwd = computed(props.cwd ?? (() => currentWorkspace()?.cwd ?? (isDraft() ? draftCwd() : null)));
  const threadId = props.threadId ?? (() => currentWorkspace()?.threadId ?? null);
  const close = props.onClose ?? toggleDetailsAction;
  const openChanges = props.onOpenChanges ?? (() => openSurfaceAction("diff"));
  const scripts = props.scripts ?? (() => { const current = project(); return current ? [...resolveProjectScripts(serverSettings(), { id: current.id, scripts: current.scripts ?? [] })] : null; });
  const projectId = props.projectId ?? (() => project()?.id ?? null);
  const runScript = props.onRunScript ?? ((script: ProjectScript) => { runProjectScript(script); });
  const visible = () => threadDetailsVisibility();
  // The reference docks the card beside the chat when the canvas has room (inline mode: 12pt below the header,
  // the lane narrows, a press elsewhere keeps it open); otherwise it is a popover under the header.
  const docked = () => threadDetailsDocks(chatCanvasSize(), windowSize().width);
  // ThreadDetailsPrRows: a link dismissed from a stack stays stored but is not listed (visibleThreadPullRequests).
  const links = () => visibleThreadPullRequests((thread()?.relations?.pullRequests ?? []) as never);
  // A thread that works in a folder other than its project's runs in a worktree.
  const worktreePath = () => { const path = thread()?.path; return path && project() && path !== project()?.path ? path : null; };
  const commitOpen = signal(false);
  const publishOpen = signal(false);
  // The action waiting on the default-ref confirmation, with what to run when it is confirmed.
  const pendingDefault = signal<(DefaultBranchGate & { extra: ActionExtra }) | null>(null);
  // The card drops over the page below the header (a native web view), as do its menus and dialogs.
  useOverlayOpen(() => open() && Boolean(cwd()), "thread details card");
  // A dialog opened from the card keeps the card (and its status stream) alive.
  const dialogs = signal(0);
  // The press that closes a dialog also lands outside the card; it must not close the card too.
  let keepUntil = 0;
  const branches = signal<ReturnType<typeof branchOptions>>(branchCache.get(cwd() ?? "") ?? []);
  const status = signal<VcsStatus | null>(statusCache.get(cwd() ?? "") ?? null);
  const statusError = signal<string | null>(null);
  const editors = () => editorsCache() ?? [];
  const progress = signal<GitProgress | null>(null);
  const result = signal<{ title: string; description: string | null; url: string | null } | null>(null);
  const clock = signal(Date.now());
  let stopAction: (() => void) | null = null;
  let resultTimer: ReturnType<typeof setTimeout> | undefined;
  let clockTimer: ReturnType<typeof setInterval> | undefined;

  const busy = () => progress() !== null;
  // canChangeThreadBranch: a feature branch run needs write access and the right to change the thread.
  const canChangeBranch = () => canWriteSourceControl() && canOperateThread();
  effect(() => { if (open()) loadSourceControlScopes(); });
  effect(() => { if (!open()) pendingDefault.set(null); });
  const os = () => platform.os;

  // Streams while the thread is open, not only while the card is: opening the card then
  // shows the current status at once instead of mounting the Git rows when it arrives.
  effect(() => {
    const folder = cwd();
    if (!folder) return;
    backendConnected(); // a reconnect closes the stream: subscribe again
    status.set(statusCache.get(folder) ?? null);
    const stop = watchVcsStatus(folder, subscribe, (next) => { if (next) statusCache.set(folder, next); else statusCache.delete(folder); status.set(next); }, (message) => statusError.set(message));
    statusError.set(null);
    return () => { stop(); };
  });
  effect(() => {
    if (!cwd() || (untracked(editorsCache) !== null && untracked(environmentCache) !== null && !open())) return;
    let live = true;
    void request("server.getConfig", {}).then((config) => {
      if (!live) return;
      editorsCache.set(readAvailableEditors(config));
      environmentCache.set({ descriptor: readEnvironmentDescriptor(config), localServerStop: localServerStopSupported(config) });
    }).catch(() => {});
    return () => { live = false; };
  });
  effect(() => {
    if (!busy()) return;
    clockTimer = setInterval(() => clock.set(Date.now()), 1000);
    return () => clearInterval(clockTimer);
  });
  effect(() => () => { stopAction?.(); clearTimeout(resultTimer); });

  function finish(title: string, url: string | null, description: string | null = null) {
    progress.set(null);
    stopAction = null;
    result.set({ title, description, url });
    clearTimeout(resultTimer);
    resultTimer = setTimeout(() => result.set(null), GIT_ACTION_SUCCESS_VISIBLE_MS);
  }
  function fail(message: string, title = "Action failed") {
    progress.set(null);
    stopAction = null;
    // Git action failures show on the thread they came from (GitActionsControl threadToastData).
    const owner = threadId();
    showToast({ type: "error", title, description: message, ...(owner ? { threadRef: { threadId: owner } } : {}) });
  }
  /** `syncThreadBranchAfterGitAction`: a thread follows the branch an action created for it. */
  function followCreatedBranch(branch: string | null) {
    const id = threadId();
    if (!branch || !id) return;
    void request("orchestration.dispatchCommand", { type: "thread.metadata.update", commandId: `command:${crypto.randomUUID()}`, threadId: id, branch })
      .catch((cause: unknown) => showToast({ type: "error", title: "Failed to update the thread's branch.", description: cause instanceof Error ? cause.message : "An error occurred." }));
  }
  /** runGitActionWithToast: asks first when the action would run on the default ref, unless `skipPrompt`. */
  function runAction(action: GitActionMenuItem["action"], extra: ActionExtra = {}, skipPrompt = false) {
    const folder = cwd();
    if (!folder || busy() || !canWriteSourceControl()) return;
    const gate = resolveDefaultBranchGate({ action, status: status(), ...(extra.featureBranch ? { featureBranch: true } : {}), skip: skipPrompt });
    if (gate) { pendingDefault.set({ ...gate, extra }); return; }
    result.set(null);
    stopAction = runGitAction({ cwd: folder, action, ...extra, ...(threadId() ? { threadId: threadId() ?? undefined } : isDraft() && projectId() ? { projectId: projectId() ?? undefined } : {}) }, subscribe, {
      onProgress: (value) => progress.set(value),
      onDone: (done) => {
        const success = inlineSuccessFor({ title: done.title, description: done.description, created: done.created === true }, status()?.sourceControlProviderKind ?? null);
        finish(success.title, done.url, success.description);
        followCreatedBranch(done.createdBranch ?? null);
      },
      onFailed: fail,
    });
  }
  function continuePending(featureBranch: boolean) {
    const waiting = pendingDefault();
    if (!waiting || !canWriteSourceControl()) return;
    if (featureBranch && (!canChangeBranch() || resolveFeatureBranchUnavailableReason({ branchName: waiting.branchName, hasWorkingTreeChanges: status()?.hasWorkingTreeChanges ?? true }) !== null)) return;
    pendingDefault.set(null);
    keepUntil = Date.now() + 400;
    runAction(waiting.action, { ...waiting.extra, ...(featureBranch ? { featureBranch: true } : {}) }, true);
  }
  async function pull() {
    const folder = cwd();
    if (!folder || busy() || !canWriteSourceControl()) return;
    progress.set({ status: "Pulling latest changes...", output: null, startedAtMs: Date.now() });
    try { const done = await runPull(folder, request); finish(done.title, null, done.description); }
    catch (cause) { fail(cause instanceof Error ? cause.message : "An error occurred.", "Pull failed"); }
  }

  function commit(request: CommitRequest) {
    keepUntil = Date.now() + 400;
    commitOpen.set(false);
    runAction("commit", {
      ...(request.message ? { commitMessage: request.message } : {}),
      ...(request.filePaths ? { filePaths: request.filePaths } : {}),
      ...(request.featureBranch ? { featureBranch: true } : {}),
    });
  }
  /** The dropdown's Commit opens the dialog (openDialogForMenuItem); Push and Create PR run at once. */
  function pickMenuItem(item: GitActionMenuItem) {
    if (item.disabled) return;
    if (item.action === "commit") commitOpen.set(true);
    else runAction(item.action);
  }
  /** GitActionsControl requestVcsStatusRefresh on opening the dropdown ({ cwd }, a full refresh with remote fetch). */
  function refreshStatus() {
    const folder = cwd();
    if (folder) void request("vcs.refreshStatus", { cwd: folder }).catch(() => {});
  }
  // useT3ProjectFileScripts: the project's t3.json, read while the card shows its scripts and again each time it opens.
  const fileScripts = signal<readonly T3ProjectFileScript[]>([]);
  effect(() => {
    const folder = cwd();
    if (!folder || !open() || !visible().scripts || scripts() === null) return;
    let live = true;
    void readT3ProjectScripts(folder, request).then((next) => { if (live) fileScripts.set(next); }).catch(() => { if (live) fileScripts.set([]); });
    return () => { live = false; };
  });
  const initializing = signal(false);
  /** `vcs.init`: the status stream then reports the new repository. */
  async function initializeGit() {
    const folder = cwd();
    if (!folder || initializing()) return;
    initializing.set(true);
    try { await request("vcs.init", { cwd: folder }); }
    catch (cause) { showToast({ type: "error", title: "Git initialization failed", description: cause instanceof Error ? cause.message : "An error occurred." }); }
    finally { initializing.set(false); }
  }
  const branchOpen = signal(false);
  // A draft's branch is part of its workspace strategy; a started thread's is the folder's own checkout.
  const draftWorktreePath = () => { const strategy = workspaceStrategy(); return strategy.type === "existing_worktree" ? strategy.worktreePath : null; };
  const draftBranchCwd = () => draftWorktreePath() ?? project()?.path ?? cwd();
  const draftBranch = () => { const strategy = workspaceStrategy(); return strategy.type === "worktree" ? strategy.baseRef : strategy.branch ?? status()?.refName ?? null; };
  /** setThreadBranch: a started thread's branch is its own metadata, a draft's part of its workspace. */
  function branchChanged(change: BranchChange) {
    const id = threadId();
    if (id && !isDraft()) {
      void request("orchestration.dispatchCommand", { type: "thread.metadata.update", commandId: `command:${crypto.randomUUID()}`, threadId: id, branch: change.branch, worktreePath: change.worktreePath })
        .catch((cause: unknown) => showToast({ type: "error", title: "Failed to update the thread's branch.", description: cause instanceof Error ? cause.message : "An error occurred." }));
      return;
    }
    try { setWorkspaceStrategy(change.worktreePath ? { type: "existing_worktree", worktreePath: change.worktreePath, branch: change.branch } : { type: "root", branch: change.branch }); }
    catch { /* the draft keeps its workspace */ }
  }
  /** The context menu of the branch row: Copy branch name. */
  function branchContextMenu(at: { x: number; y: number }, branch: string | null) {
    if (!branch) return;
    void PopupMenu.popup([{ label: "Copy branch name", onSelect: () => { void Clipboard.writeText(branch).then(() => showToast({ type: "success", title: "Branch name copied", description: branch }), (cause: unknown) => showToast({ type: "error", title: "Failed to copy branch name", description: cause instanceof Error ? cause.message : "An error occurred." })); } }], at);
  }
  // "Run on": the connected environment and the saved ones the app can switch to (as the composer strip lists them).
  void loadSavedEnvironments();
  const environmentOptions = () => buildEnvironmentOptions({
    connected: backendStatus() === "connected" && serverEnvironmentSignal() ? { id: String(serverEnvironmentSignal()?.environmentId ?? "primary"), label: String(serverEnvironmentSignal()?.label ?? "This machine") } : null,
    currentUrl: backendUrl(), saved: savedEnvironments(),
  });
  function itemsMenu(at?: { x: number; y: number }) {
    const current = threadDetailsVisibility();
    void PopupMenu.popup([
      { label: "Show in thread details", disabled: true },
      ...THREAD_DETAILS_ITEMS.map((item) => ({ label: item.label, checked: current[item.id], onSelect: () => setThreadDetailsItemVisible(item.id, !current[item.id]) })),
      { type: "separator" as const },
      { label: "Reset to default", disabled: isDefaultThreadDetailsVisibility(current), onSelect: resetThreadDetailsItems },
    ], at);
  }

  /** `latestRun === null`: the shell reports no run yet (a thread without shell meta is not assumed empty). */
  const threadHasNoRun = () => {
    const meta = (thread() as { meta?: { runStatus: string; activityRunStatus: string | null; latestRunStartedAt: number | null; latestRunCompletedAt: number | null } } | null | undefined)?.meta;
    return !!meta && meta.runStatus === "idle" && meta.activityRunStatus === null && meta.latestRunStartedAt === null && meta.latestRunCompletedAt === null;
  };
  const quick = () => resolveQuickAction(status(), busy(), status()?.isDefaultRef ?? false, status()?.hasPrimaryRemote ?? true);
  const disabledReason = () => quickActionDisabledReason({ canWrite: canWriteSourceControl(), disabled: quick().disabled, hint: quick().hint });
  const terms = () => changeRequestTerms(status()?.sourceControlProviderKind ?? null);
  // quietEmptyDraft: a fresh draft, or a thread that has not run yet, hides the commit, push and diff rows until there is work.
  const quiet = () => quietEmptyDraft({
    draft: isDraft(), noRunYet: threadHasNoRun(),
    busy: busy(), statusError: statusError(), quickDisabled: quick().disabled, insertions: totals()?.insertions ?? 0, deletions: totals()?.deletions ?? 0,
  });
  const menuItems = () => buildMenuItems(status(), busy(), status()?.hasPrimaryRemote ?? true);
  const totals = () => resolveChangesTotals(status());
  const options = () => resolveOpenInOptions(os(), editors());
  const preferred = () => effectiveEditor(lastEditor(), editors());
  const preferredOption = () => options().find((option) => option.value === preferred()) ?? null;

  function chooseEditor(editor: string) {
    lastEditor.set(editor);
    void Storage.setItem("lastEditor", editor).catch(() => {});
  }
  // OpenInPicker remote rows (remoteOpen.ts): a thread on another machine opens through the editor's remote link.
  const remoteOpen = () => threadRemoteOpenState();
  // A thread with no environment id is the primary (this machine) one.
  const PRIMARY_ENVIRONMENT = "primary";
  const threadEnvironmentId = () => openThread()?.environmentId ?? null;
  const remoteLabel = () => threadEnvironmentLabel() ?? "this machine";
  const remoteHintSeen = signal(true);
  void remoteOpenHintSeen().then((seen) => remoteHintSeen.set(seen));
  function launchEditor() {
    const folder = cwd();
    const editor = preferred();
    if (!folder || !editor) return;
    chooseEditor(editor);
    if (remoteOpen().mode === "remote-links" && !remoteHintSeen()) { remoteHintSeen.set(true); markRemoteOpenHintSeen(); }
    // OpenInPicker: a successful open is spoken ("Opened in <editor>").
    void openThreadFolderInEditor(folder, editor, request).then(() => announce(`Opened in ${editorLabel(editor, os())}`)).catch((cause: unknown) => showToast({ type: "error", title: "Unable to open editor", description: cause instanceof Error ? cause.message : "An error occurred." }));
  }
  function pressQuick() {
    const action = quick();
    if (action.disabled || busy() || !canWriteSourceControl()) return;
    if (action.kind === "open_publish") publishOpen.set(true);
    else if (action.kind === "run_pull") void pull();
    else if (action.kind === "run_action" && action.action) runAction(action.action);
  }

  const hasProject = () => scripts() !== null;
  // ThreadDetailsCard density tiers: measured content that does not fit drops sections (threadDetailsDensity.ts).
  const cardHeight = () => Math.max(160, windowSize().height - 104);
  const measureKey = () => `${threadId() ?? ""}:${JSON.stringify(visible())}`;
  const measured = signal({ key: "", full: 0, compact: 0 });
  const density = () => { const current = measured(); return resolveThreadDetailsCardDensity(cardHeight(), current.key === measureKey() ? current : { full: 0, compact: 0 }); };
  // The scrolling lists (servers, automations, lineage, side chats) do not count toward density, as in the reference.
  let headHeight = 0;
  let tailHeight = 0;
  const remeasure = () => untracked(() => measured.set(recordDetailsMeasurement(measured(), measureKey(), density(), headHeight + tailHeight)));
  const showEnvironment = () => visible().environment && thread() !== null && density() === "full";
  // shouldShowOpenInPicker: a project name is needed (a thread on another machine also needs a remote route to show it).
  const showOpenIn = () => Boolean(cwd()) && shouldShowOpenInPicker({ activeProjectName: project()?.name ?? cwd()?.split(/[\\/]/).filter(Boolean).pop(), activeThreadEnvironmentId: threadEnvironmentId() ?? PRIMARY_ENVIRONMENT, primaryEnvironmentId: PRIMARY_ENVIRONMENT, remoteOpenMode: remoteOpen().mode }) && visible().openIn && density() !== "essential";
  // OPEN_FAVORITE_EDITOR_ATTRIBUTE: while the picker's primary button is on screen, `editor.openFavorite` presses it.
  effect(() => {
    if (!showOpenIn()) return;
    return registerOpenFavoriteTarget({ press: launchEditor, enabled: () => Boolean(preferred()) && scopeAllows(ORCHESTRATION_OPERATE_SCOPE) });
  });
  const showScripts = () => visible().scripts && hasProject();
  const isRepo = () => status()?.isRepo === true;
  const showBranch = () => Boolean(cwd()) && isRepo() && visible().branch;
  // GitActionsControl: Git actions also offers Initialize Git in a folder that is no repository; Changes needs one.
  const showGit = () => Boolean(cwd()) && status() !== null && hasProject() && (visible().gitActions || (visible().changes && isRepo()));
  const showVersionControl = () => showBranch() || showGit();
  const showWorkspace = () => showEnvironment() || showOpenIn() || showScripts();
  useSectionPresence("workspace", showWorkspace);
  useSectionPresence("versionControl", showVersionControl);
  const nothingShown = () => !showWorkspace() && !showVersionControl() && !visible().servers && !visible().automations && !visible().lineage && !visible().sideChats && !visible().usage && !visible().context;

  return (
    <>
      {open() && cwd() ? (
        <Overlay anchor={props.anchor?.() ?? null} placement="bottom" align="end" offset={(docked() ? THREAD_DETAILS_CARD_GAP : 0) + (docked() && threadFindOpen() ? THREAD_FIND_BAR_RESERVED_HEIGHT : 0)} margin={12} onPressOutside={() => { if (!docked() && dialogs() === 0 && !commitOpen() && !publishOpen() && pendingDefault() === null && !branchOpen() && Date.now() > keepUntil) close(); }} onCancel={close}>
          <View class="w-[280px] overflow-hidden rounded-2xl border border-details-card-border bg-popover-84" testID="Thread details" role="region" accessibilityLabel="Thread details" onContextMenu={(event) => itemsMenu(event.pagePosition)}>
            {/* max-h-[min(calc(100dvh-6.5rem), ...)]: a long card scrolls inside the window. */}
            <FadeScroll surface="popover-84" style={{ maxHeight: cardHeight() }}>
            <View onLayout={(event) => { headHeight = event.bounds.size.height; remeasure(); }}>
            {showWorkspace() ? (
              <View class="px-2 pb-2.5 pt-2">
                {showEnvironment() ? (isDraft() ? (
                  <RunContextRow
                    strategy={workspaceStrategy}
                    onSelectWorkspace={setWorkspaceStrategy}
                    activeWorktreePath={() => { const strategy = workspaceStrategy(); return strategy.type === "existing_worktree" ? strategy.worktreePath : null; }}
                    projectPath={() => project()?.path ?? null}
                    seed={(branchOf) => { const current = project(); const strategy = workspaceStrategy(); return current ? resolvePreviousWorktreeSeed({ threads: allThreads().filter((item) => item.projectId === current.id), currentWorktreePath: strategy.type === "existing_worktree" ? strategy.worktreePath : null, branchOf }) : null; }}
                    environments={environmentOptions}
                    activeEnvironmentId={() => environmentOptions().find((item) => item.isPrimary)?.environmentId ?? null}
                    onSelectEnvironment={(option) => { if (option.url) configureBackend(option.url); }}
                    disabled={() => backendStatus() !== "connected" || isSending()}
                    request={request}
                    onOpenChange={(isOpen) => { if (!isOpen) keepUntil = Date.now() + 400; dialogs.update((count) => Math.max(0, count + (isOpen ? 1 : -1))); }}
                  />
                ) : <EnvironmentRow worktreePath={worktreePath} environment={() => environmentCache()?.descriptor ?? null} />) : null}
                {showOpenIn() ? <View role="group" accessibilityLabel="Open in editor" class="w-full flex-row items-center rounded-lg">
                  <View
                    role="button"
                    ref={focusTargets.track as never}
                    onFocus={() => noteFocusArea("details")}
                    accessibilityLabel={openInButtonLabel(preferredOption())}
                    // OpenInPicker canOperateHost: opening a host editor needs orchestration:operate.
                    disabled={!preferred() || !scopeAllows(ORCHESTRATION_OPERATE_SCOPE)}
                    onPress={launchEditor}
                    class={`${rowClass} flex-1 ${preferred() && scopeAllows(ORCHESTRATION_OPERATE_SCOPE) ? "" : "opacity-64"}`}
                  >
                    {preferredOption() ? <EditorIcon editor={preferredOption()!.value} os={os()} size={16} /> : <HIcon name="square-arrow-out-up-right" size={16} />}
                    <Text class={labelClass}>{openInButtonLabel(preferredOption())}</Text>
                  </View>
                  <Menu
                    popupClass={menuClass}
                    align="end"
                    trigger={<View role="button" accessibilityLabel="Choose editor" class={splitButtonClass}><HIcon name="chevron-down" size={16} /></View>}
                  >
                    {remoteOpen().mode === "remote-unavailable" ? (
                      <MenuItem disabled class={itemClass}><Text class="text-sm text-popover-foreground">{`No SSH route to ${remoteLabel()}`}</Text></MenuItem>
                    ) : options().length === 0 ? (
                      <MenuItem disabled class={itemClass}><Text class="text-sm text-popover-foreground">No installed editors found</Text></MenuItem>
                    ) : (
                      <Each of={options()} key={(option) => option.value}>
                        {(option) => (
                          <MenuItem accessibilityLabel={option().label} class={itemClass} onSelect={() => chooseEditor(option().value)}>
                            <EditorIcon editor={option().value} os={os()} size={16} />
                            <Text class="text-sm text-popover-foreground">{option().label}</Text>
                          </MenuItem>
                        )}
                      </Each>
                    )}
                    {remoteOpen().mode === "remote-links" && !remoteHintSeen() ? (
                      <MenuItem disabled class={itemClass}><Text class="text-sm text-popover-foreground">{`Opens over SSH. Needs your key on ${remoteLabel()}`}</Text></MenuItem>
                    ) : null}
                  </Menu>
                </View> : null}
                {showScripts() ? (
                  <ProjectScriptsRow
                    scripts={() => scripts() ?? []}
                    fileScripts={fileScripts}
                    preferredScriptId={() => lastInvokedScriptId(projectId())}
                    onRun={runScript}
                    onDialogChange={(isOpen) => { if (!isOpen) keepUntil = Date.now() + 400; dialogs.update((count) => Math.max(0, count + (isOpen ? 1 : -1))); }}
                    onSave={async (next) => { const id = projectId(); if (!id) throw new Error("This thread has no project."); await saveProjectScripts(id, next, request); }}
                  />
                ) : null}
              </View>
            ) : null}
            {showVersionControl() ? (
              <View class={`px-2 pb-2.5 pt-2 ${showWorkspace() ? "border-t border-details-divider" : ""}`}>
                {showBranch() ? (
                  <BranchSelector
                    variant="panel"
                    open={branchOpen}
                    cwd={() => (isDraft() ? draftBranchCwd() : cwd())}
                    projectCwd={() => project()?.path ?? cwd()}
                    activeWorktreePath={() => (isDraft() ? draftWorktreePath() : worktreePath())}
                    branch={() => (isDraft() ? draftBranch() : status()?.refName ?? null)}
                    selectingWorktreeBase={() => isDraft() && workspaceStrategy().type === "worktree"}
                    canCreate={() => backendStatus() === "connected" || props.request !== undefined}
                    disabled={() => isDraft() && isSending()}
                    request={(method, payload) => request(method, payload)}
                    canChange={canChangeBranch}
                    onUnavailable={() => showToast({ type: "error", title: "Action unavailable", description: "This connection cannot change the thread's branch." })}
                    onError={(message, action) => showToast({ type: "error", title: branchActionFailureTitle(action), description: message })}
                    onSelectBase={(refName) => { const current = workspaceStrategy(); try { setWorkspaceStrategy({ type: "worktree", baseRef: refName, ...(current.type === "worktree" && current.startFromOrigin !== undefined ? { startFromOrigin: current.startFromOrigin } : {}) }); } catch { /* the draft keeps its workspace */ } }}
                    onBranchChanged={branchChanged}
                    startFromOrigin={() => { const current = workspaceStrategy(); return current.type === "worktree" && current.startFromOrigin === true; }}
                    onStartFromOriginChange={(checked) => { const current = workspaceStrategy(); if (current.type === "worktree") { try { setWorkspaceStrategy({ ...current, startFromOrigin: checked }); } catch { /* the draft keeps its workspace */ } } }}
                    onTriggerContextMenu={(event, branch) => branchContextMenu(event.pagePosition, branch)}
                  />
                ) : null}
                {showBranch() && links().length > 0 ? <PullRequestRows links={links} projectId={() => project()?.id ?? ""} /> : null}
                {visible().gitActions && !isRepo() ? (
                  <View role="button" accessibilityLabel={initializing() ? "Initializing..." : "Initialize Git"} disabled={initializing()} onPress={() => void initializeGit()} class={`${rowClass} ${initializing() ? "opacity-64" : ""}`}>
                    <HIcon name="git-branch-plus" size={14} />
                    <Text class={`${labelClass} ml-0.5`}>{initializing() ? "Initializing..." : "Initialize Git"}</Text>
                  </View>
                ) : null}
                {visible().gitActions && isRepo() && !quiet() && (density() === "full" || busy() || result() !== null) ? <View role="group" accessibilityLabel="Git actions" class={`w-full flex-row items-center rounded-lg ${busy() ? "bg-details-row-hover" : ""}`}>
                  {busy() ? (
                    <View role="button" accessibilityLabel={progress()?.output ? `${progress()?.status} ${progress()?.output}` : progress()?.status} disabled class={`${rowClass} flex-1`}>
                      <HIcon name="rotate-cw" size={16} />
                      <View class="min-w-0 flex-1">
                        <Text class="truncate text-[13px] font-medium text-details-label">{progress()?.status}</Text>
                        {progress()?.output ? <Text class="truncate text-xs text-muted-foreground" style={enterStyle(gitOutputReveal)}>{progress()?.output}</Text> : null}
                      </View>
                      <Text class="text-xs text-muted-foreground">{elapsed(progress()?.startedAtMs ?? clock(), clock())}</Text>
                    </View>
                  ) : result() ? (
                    <View
                      role="button"
                      accessibilityLabel={result()?.title}
                      disabled={!result()?.url}
                      onPress={() => { const url = result()?.url; if (url) void openUrl(url).catch(() => {}); }}
                      class={`${rowClass} flex-1`}
                    >
                      <HIcon name="check" size={16} />
                      <View class="min-w-0 flex-1">
                        <Text class="truncate text-[13px] font-medium text-details-label">{result()?.title}</Text>
                        {result()?.description ? <Text class="truncate text-xs text-muted-foreground" style={enterStyle(gitOutputReveal)}>{result()?.description}</Text> : null}
                      </View>
                    </View>
                  ) : (
                    <View
                      role="button"
                      accessibilityLabel={quick().label}
                      disabled={disabledReason() === null && quick().disabled}
                      tooltip={disabledReason() !== null ? <Tip text={disabledReason() ?? ""} /> : undefined}
                      onPress={pressQuick}
                      class={`${rowClass} flex-1 ${quick().disabled || disabledReason() !== null ? "opacity-64" : ""}`}
                    >
                      <HIcon name={quickActionIconName(quick(), status()?.sourceControlProviderKind ?? null)} size={16} />
                      <Text class={labelClass}>{quick().label}</Text>
                    </View>
                  )}
                  {!busy() ? (
                    <Menu
                      popupClass={menuClass}
                      align="end"
                      onOpenChange={(event: { open: boolean }) => { if (event.open) refreshStatus(); }}
                      trigger={<View role="button" accessibilityLabel="Git action options" class={splitButtonClass}><HIcon name="chevron-down" size={16} /></View>}
                    >
                      <Each of={menuItems()} key={(item) => item.id}>
                        {(item) => (
                          <MenuItem
                            accessibilityLabel={item().label}
                            disabled={item().disabled || !canWriteSourceControl()}
                            class={itemClass}
                            tooltip={item().disabled ? <Tip text={menuItemDisabledReason(item(), status(), busy(), status()?.hasPrimaryRemote ?? true) ?? ""} /> : undefined}
                            onSelect={() => pickMenuItem(item())}
                          >
                            <HIcon name={item().icon === "commit" ? "git-commit-horizontal" : item().icon === "push" ? "cloud-upload" : changeRequestIconName(status()?.sourceControlProviderKind ?? null)} size={16} />
                            <Text class="text-sm text-popover-foreground">{item().label}</Text>
                          </MenuItem>
                        )}
                      </Each>
                      {canPublishRepository({ canWrite: canWriteSourceControl(), status: status() }) ? (
                        <MenuItem accessibilityLabel="Publish repository..." disabled={busy()} class={itemClass} onSelect={() => publishOpen.set(true)}>
                          <HIcon name="cloud-upload" size={16} />
                          <Text class="text-sm text-popover-foreground">Publish repository...</Text>
                        </MenuItem>
                      ) : null}
                      {status()?.refName === null ? <><MenuSeparator class={MENU_SEPARATOR_CLASS} /><Text class="px-2 py-1.5 text-xs text-warning-foreground">{`Detached HEAD: create and check out a branch to enable push and ${terms().singular} actions.`}</Text></> : null}
                      {behindUpstreamNote(status()) ? <Text class="px-2 py-1.5 text-xs text-warning-foreground">{behindUpstreamNote(status())}</Text> : null}
                    </Menu>
                  ) : null}
                </View> : null}
                {visible().changes && isRepo() && !quiet() ? <View role="button" ref={focusTargets.track as never} onFocus={() => noteFocusArea("details")} accessibilityLabel="Changes" onPress={openChanges} class={rowClass}>
                  <HIcon name="file-diff" size={16} />
                  <View class="min-w-0 flex-1 flex-row items-baseline gap-1.5">
                    <Text class="shrink-0 text-[13px] font-medium text-details-label">Changes</Text>
                    {changesBaseLabel(totals()) ? <Text class="min-w-0 shrink truncate text-[13px] font-normal text-muted-foreground" tooltip={<Tip text={changesBaseLabel(totals()) ?? ""} />}>{changesBaseLabel(totals())}</Text> : null}
                    <View class="ml-auto shrink-0 flex-row items-baseline gap-2 pl-2" accessibilityLabel="Changes totals">
                      <Text class={`shrink-0 font-mono text-[13px] ${(totals()?.insertions ?? 0) > 0 ? diffAdditionClass("text-emerald-700 dark:text-emerald-400") : "text-muted-foreground"}`}>{`+${formatDiffCount(totals()?.insertions ?? 0)}`}</Text>
                      <Text class={`shrink-0 font-mono text-[13px] ${(totals()?.deletions ?? 0) > 0 ? diffDeletionClass("text-red-700 dark:text-red-400") : "text-muted-foreground"}`}>{`-${formatDiffCount(totals()?.deletions ?? 0)}`}</Text>
                    </View>
                  </View>
                </View> : null}
              </View>
            ) : null}
            </View>
            <If when={() => density() === "full"}>{() => <View>
            {visible().servers && !isDraft() ? <ThreadServers threadId={threadId} canStop={() => environmentCache()?.localServerStop === true} {...(props.subscribe ? { subscribe: props.subscribe } : {})} {...(props.request ? { request: props.request } : {})} /> : null}
            {visible().automations && !isDraft() ? <ThreadAutomations threadId={threadId} {...(props.subscribe ? { subscribe: props.subscribe } : {})} {...(props.request ? { request: props.request } : {})} /> : null}
            <If when={() => !isDraft()}>{() => <ThreadRelationships threads={props.threads} {...(props.request ? { request: props.request } : {})} thread={() => { const current = thread(); return current ? { id: current.id, lineage: current.relations?.lineage, forkSourceThreadId: current.relations?.forkSourceThreadId, delegatedFrom: current.relations?.delegatedFrom, linkOrigin: current.relations?.linkOrigin ?? null } : null; }} showLineage={() => visible().lineage} showSideChats={() => visible().sideChats} />}</If>
            </View>}</If>
            <View onLayout={(event) => { tailHeight = event.bounds.size.height; remeasure(); }}>
            {visible().usage ? <ThreadDetailsUsage limits={props.limits ?? providerUsageLimits} /> : null}
            {visible().context ? <ThreadDetailsContext usage={props.contextUsage ?? (() => latestTokenUsage(providerState()))} /> : null}
            {nothingShown() ? (
              <View class="p-2">
                <View role="button" ref={focusTargets.track as never} onFocus={() => noteFocusArea("details")} accessibilityLabel="Choose what to show" onPress={(event) => itemsMenu(event.pagePosition)} class={rowClass}>
                  <HIcon name="sliders-horizontal" size={16} />
                  <Text class={labelClass}>Choose what to show</Text>
                </View>
              </View>
            ) : null}
            {statusError() ? <Text class="px-4 pb-3 text-xs text-error-foreground" role="alert">{statusError()}</Text> : null}
            </View>
            </FadeScroll>
          </View>
        </Overlay>
      ) : null}
      <DefaultBranchDialog
        pending={() => (open() ? pendingDefault() : null)}
        terminology={terms}
        hasWorkingTreeChanges={() => status()?.hasWorkingTreeChanges ?? true}
        canWrite={canWriteSourceControl}
        canChangeBranch={canChangeBranch}
        onAbort={() => { keepUntil = Date.now() + 400; pendingDefault.set(null); }}
        onContinue={continuePending}
      />
      <PublishRepositoryDialog
        open={() => publishOpen() && open()}
        cwd={cwd}
        request={request}
        canWrite={canWriteSourceControl}
        onClose={() => { keepUntil = Date.now() + 400; publishOpen.set(false); }}
        onOpenSettings={() => openSettings("/settings/source-control")}
      />
      <CommitDialog
        open={() => commitOpen() && open()}
        branch={() => status()?.refName ?? null}
        isDefaultRef={() => status()?.isDefaultRef ?? false}
        files={() => status()?.workingTree.files ?? []}
        onCancel={() => { keepUntil = Date.now() + 400; commitOpen.set(false); }}
        onCommit={commit}
      />
    </>
  );
}
