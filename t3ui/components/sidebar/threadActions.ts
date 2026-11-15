// The thread action menu, ported from threadActionMenu.logic.ts (buildThreadActionMenuItems)
// and the handlers in Sidebar.tsx. Items the native app cannot honour yet (find in thread, which
// the sidebar menu never passes `canFind` for, and share with guest) are left out, as the web
// leaves out an item whose `supports` flag is false.
import { claimThreadUndoShortcut, releaseThreadUndoShortcut, setThreadUndoRunner } from "./threadUndoClaim";
import { forgetThreadPanel } from "../rightPanel/panelState";
import { announce, Clipboard, signal } from "nsh";
import { releaseThreadDraft } from "../../store";
import { allProjects, allThreads, backendStatus, createThread, openSettings, openThread, openThreadById, requestBackend, restoreThread, settingValue, setThreadPinned, renameThread, archiveThread } from "../../store";
import { fallbackThreadIdAfterDelete } from "./threadSort";
import { confirmOrphanedWorktree, sideChatsOfDeletedThread } from "./threadFamilyDelete";
import type { Thread } from "../../store";
import { validWorkspaceStrategy } from "../../backend/launch";
import { runCommand, shortcutLabel } from "../../commands/registry";
import { confirm as askConfirm, errorToast, showToast } from "../toast";
import { showSidebarProjectSettings } from "../SidebarProjectSettingsState";
import { canSnooze, isSnoozed } from "./threadStatus";
import { clearThreadSelection, removeFromSelection } from "./threadSelection";
import { canTurnThreadIntoProject, configLoaded, environmentId, hostedThreadLink, isScratchProjectPath, scratchWorkspaceRoot, supportsAutoSettleOptOut } from "./serverFacts";
import { archiveBlockedReason, orphanedWorktreePath, removeWorktreeAfterDelete, shouldAskToDeleteWorktree, THREAD_ACTION_ERRORS, worktreeDeleteQuestion } from "./threadWorktreeCleanup";
import { canOperateThread, canWriteSourceControl, loadSourceControlScopes } from "../header/sourceControlScope";
import { resolveWorktreeCleanup } from "../../pages/settings/scopeCore";
import type { SnoozePreset } from "./snooze";
import { canShareWithGuest, openGuestShareDialog } from "../header/guestShare";
import { serverManagedPolicy, serverSettings } from "../../pages/settings/settingsState";

export type ThreadMenuId =
  | "find" | "share-guest" | "new-thread-on-branch" | "pin" | "unpin" | "settle" | "unsettle" | "snooze" | `snooze:${string}`
  | "unsnooze" | "rename" | "regenerate-title" | "mark-unread" | "copy" | "copy-path" | "copy-branch"
  | "copy-thread" | "copy-thread-id" | "project-settings" | "archive" | "delete"
  | "filter-by-project" | "turn-into-project" | "auto-settle" | "auto-settle:enabled" | "auto-settle:disabled"
  | "bulk:unpin" | "bulk:settle" | "bulk:snooze" | `bulk:snooze:${string}` | "bulk:regenerate-title" | "bulk:mark-unread" | "bulk:delete";

export interface ThreadMenuItem {
  id: ThreadMenuId;
  label: string;
  /** Lucide name, matching the web's `icon` field. */
  icon?: string;
  disabled?: boolean;
  destructive?: boolean;
  separatorBefore?: boolean;
  /** A checkable item: true draws the check, false leaves its place empty. */
  checked?: boolean;
  children?: ThreadMenuItem[];
}

export interface ThreadMenuState {
  branch: string | null;
  hasPath: boolean;
  hasProject: boolean;
  isPinned: boolean;
  isSettled: boolean;
  isSnoozed: boolean;
  canSnoozeNow: boolean;
  /** The thread header offers Find in thread when a handler is registered for the find command. */
  canFind?: boolean;
  /** Guest links are on for this environment (canShareWithGuest). */
  canShareWithGuest?: boolean;
  isRegeneratingTitle: boolean;
  isRunning: boolean;
  /** An archive request for this thread is in flight. */
  isArchiving?: boolean;
  supports: { settlement: boolean; snooze: boolean; pinning: boolean; titleRegeneration: boolean; autoSettleOptOut?: boolean };
  snoozePresets: readonly SnoozePreset[];
  /** The thread's project, as a filter choice; null for a thread with no project. */
  projectFilter?: { label: string; isActive: boolean } | null;
  autoSettleEnabled?: boolean;
  /** A No project thread with its own folder, on a server that can promote it. */
  canTurnIntoProject?: boolean;
}

/** buildThreadActionMenuItems, minus the entries listed at the top of this file. */
export function buildThreadMenu(state: ThreadMenuState): ThreadMenuItem[] {
  return [
    ...(state.canFind ? [{ id: "find" as const, label: "Find in thread", icon: "text-search" }] : []),
    ...(state.branch ? [{ id: "new-thread-on-branch" as const, label: `New thread on ${state.branch}`, icon: "message-square-plus" }] : []),
    ...(state.supports.pinning
      ? [state.isPinned
        ? { id: "unpin" as const, label: "Unpin thread", icon: "pin-off" }
        : { id: "pin" as const, label: "Pin thread", icon: "pin" }]
      : []),
    ...(state.supports.settlement
      ? [state.isSettled
        ? { id: "unsettle" as const, label: "Un-settle thread", icon: "circle-check" }
        : { id: "settle" as const, label: "Settle thread", icon: "circle-check" }]
      : []),
    ...(state.supports.snooze
      ? [state.isSnoozed
        ? { id: "unsnooze" as const, label: "Wake thread", icon: "clock" }
        : {
          id: "snooze" as const,
          label: "Snooze",
          icon: "clock",
          disabled: !state.canSnoozeNow,
          children: [
            ...state.snoozePresets.map((preset) => ({
              id: `snooze:${preset.id}` as const,
              label: `${preset.label} (${preset.whenLabel})`,
            })),
            { id: "snooze:custom" as const, label: "Custom…", separatorBefore: state.snoozePresets.length > 0 },
          ],
        }]
      : []),
    { id: "rename", label: "Rename thread", icon: "pencil", separatorBefore: true },
    ...(state.supports.titleRegeneration
      ? [{
        id: "regenerate-title" as const,
        label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
        icon: "refresh-cw",
        disabled: state.isRegeneratingTitle,
      }]
      : []),
    { id: "mark-unread", label: "Mark unread", icon: "mail-open" },
    ...(state.canShareWithGuest ? [{ id: "share-guest" as const, label: "Share with guest", icon: "user" }] : []),
    ...(state.projectFilter
      ? [{
        id: "filter-by-project" as const,
        label: state.projectFilter.isActive ? "Show all projects" : `Filter by ${state.projectFilter.label}`,
        icon: "folder-tree",
      }]
      : []),
    ...(state.canTurnIntoProject
      ? [{ id: "turn-into-project" as const, label: "Turn into project", icon: "folder-plus", disabled: state.isRunning }]
      : []),
    ...(state.supports.autoSettleOptOut
      ? [{
        id: "auto-settle" as const,
        label: "Auto-settle behavior",
        icon: "timer",
        children: [
          { id: "auto-settle:enabled" as const, label: "Follow settings", checked: state.autoSettleEnabled !== false },
          { id: "auto-settle:disabled" as const, label: "Never", checked: state.autoSettleEnabled === false },
        ],
      }]
      : []),
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      separatorBefore: true,
      children: [
        { id: "copy-path", label: "Path", icon: "folder", disabled: !state.hasPath },
        ...(state.branch ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }] : []),
        { id: "copy-thread", label: "Thread", icon: "message-square" },
        { id: "copy-thread-id", label: "Thread ID", icon: "hash" },
      ],
    },
    ...(state.hasProject ? [{ id: "project-settings" as const, label: "Project settings", icon: "settings" }] : []),
    { id: "archive", label: "Archive thread", icon: "archive", disabled: state.isRunning || state.isArchiving === true, separatorBefore: true },
    { id: "delete", label: "Delete", icon: "trash", destructive: true },
  ];
}

/** Whether the confirm prompts apply: `confirmThreadDelete` defaults on, `confirmThreadArchive` off. */
export function confirmsDelete(): boolean {
  return settingValue("confirmThreadDelete") !== false;
}
export function confirmsArchive(): boolean {
  return settingValue("confirmThreadArchive") === true;
}

/** useThreadActions unpinThread: asks first when `confirmThreadUnpin` is on (requestThreadUnpinConfirmation), then
 * unpins with the Unpinned undo notice. Resolves false when the user kept the pin. */
export async function unpinThreadWithUndo(thread: Pick<Thread, "id" | "title">): Promise<boolean> {
  if (settingValue("confirmThreadUnpin") === true) {
    const ok = await askConfirm([`Unpin thread "${thread.title}"?`, "This will move the thread out of your pinned section."].join("\n"));
    if (!ok) return false;
  }
  setThreadPinned(thread.id, false);
  threadUndo.show("Unpinned", async () => setThreadPinned(thread.id, true), thread.id);
  return true;
}

function commandId() {
  return `command:${crypto.randomUUID()}`;
}

/** orchestration.dispatchCommand, the same RPC the store's own thread actions use. */
/** threadOperationFailure (useThreadActions.ts:263-275): without orchestration:operate the action fails at once. */
export const THREAD_OPERATE_DENIED = "This connection cannot change threads.";
export function dispatchThreadCommand(command: Record<string, unknown>): Promise<unknown> {
  if (!canOperateThread()) return Promise.reject(new Error(THREAD_OPERATE_DENIED));
  return requestBackend("orchestration.dispatchCommand", { ...command, commandId: commandId() });
}

/**
 * `readEnvironmentServerConfigLoaded` false: connected, but the server has not described itself yet, so what it
 * supports is unknown and the action refuses with the reference's "does not support ... yet" message.
 */
const serverCapabilitiesUnknown = () => backendStatus() === "connected" && !configLoaded();
const refuse = (message: string) => Promise.reject(new Error(message));

export function settleThread(id: string): Promise<unknown> {
  if (serverCapabilitiesUnknown()) return refuse(THREAD_ACTION_ERRORS.settleUnsupported);
  return dispatchThreadCommand({ type: "thread.settle", threadId: id });
}
export function unsettleThread(id: string): Promise<unknown> {
  if (serverCapabilitiesUnknown()) return refuse(THREAD_ACTION_ERRORS.settleUnsupported);
  expireThreadUndos(id, ["settle"]);
  return dispatchThreadCommand({ type: "thread.unsettle", threadId: id, reason: "user" });
}
export function snoozeThread(id: string, snoozedUntil: string): Promise<unknown> {
  if (serverCapabilitiesUnknown()) return refuse(THREAD_ACTION_ERRORS.snoozeUnsupported);
  const thread = allThreads().find((candidate) => candidate.id === id);
  if (thread && !canSnooze(thread, Date.now())) return refuse(THREAD_ACTION_ERRORS.snoozeBlocked);
  return dispatchThreadCommand({ type: "thread.snooze", threadId: id, snoozedUntil });
}
export function unsnoozeThread(id: string): Promise<unknown> {
  if (serverCapabilitiesUnknown()) return refuse(THREAD_ACTION_ERRORS.snoozeUnsupported);
  return dispatchThreadCommand({ type: "thread.unsnooze", threadId: id, reason: "user" });
}
export function markThreadUnread(id: string): Promise<unknown> {
  return dispatchThreadCommand({ type: "thread.mark-unread", threadId: id });
}
export function visitThread(id: string, opened: boolean): Promise<unknown> {
  return dispatchThreadCommand({ type: "thread.visit", threadId: id, visitedAt: new Date().toISOString(), opened });
}
/** thread.pin.reorder / thread.active.reorder: one key write of a drop inside Pinned or Active. */
export function reorderThread(section: "pinned" | "active", id: string, orderKey: string): Promise<unknown> {
  return dispatchThreadCommand({ type: section === "pinned" ? "thread.pin.reorder" : "thread.active.reorder", threadId: id, orderKey });
}
/** Dismisses a Woke indicator by visiting the thread as of the wake time (useAcknowledgeThreadWoke). */
export function acknowledgeThreadWoke(id: string, wokeAt: number): Promise<unknown> {
  return dispatchThreadCommand({ type: "thread.visit", threadId: id, visitedAt: new Date(wokeAt).toISOString(), opened: false });
}
export function regenerateThreadTitle(id: string): Promise<unknown> {
  return dispatchThreadCommand({ type: "thread.metadata.update", threadId: id, regenerateTitle: true });
}
export function deleteThread(id: string): Promise<unknown> {
  return dispatchThreadCommand({ type: "thread.delete", threadId: id }).then((result) => { forgetThreadPanel(id); return result; });
}

/**
 * useThreadActions' deleteThread: a thread that is the only one on its worktree asks "Delete the worktree too?" first
 * (unless the server cleans up on its own); once the thread is gone the worktree is removed, and a failure there has its
 * own toast rather than reading as a failed delete. `deletedIds` are threads going with it (a bulk delete).
 */
export async function deleteThreadWithWorktree(thread: Thread, deletedIds?: ReadonlySet<string>): Promise<void> {
  const project = allProjects().find((item) => item.id === thread.projectId);
  loadSourceControlScopes();
  const worktreePath = await confirmOrphanedWorktree(orphanedWorktreePath(allThreads(), thread.id, deletedIds), thread.id, deletedIds, requestBackend);
  const projectCwd = project?.path ?? null;
  const facts = {
    worktreePath, projectCwd,
    isScratchProject: isScratchProjectPath(project?.path, scratchWorkspaceRoot()),
    canWriteSourceControl: canWriteSourceControl(),
    automaticCleanup: resolveWorktreeCleanup(serverSettings() as Record<string, unknown> | null, thread.projectId).worktreeOnDelete === true,
  };
  const removeWorktree = shouldAskToDeleteWorktree(facts) && worktreePath !== null ? await askConfirm(worktreeDeleteQuestion(worktreePath), { variant: "destructive" }) : false;
  await deleteThread(thread.id);
  if (!removeWorktree || worktreePath === null || projectCwd === null) return;
  const failure = await removeWorktreeAfterDelete({ projectCwd, worktreePath, canWriteSourceControl: canWriteSourceControl() }, requestBackend);
  if (failure) errorToast(failure.title, failure.description);
}

/**
 * useThreadActions' deleteThread for a thread the shell does not hold (an archived one): once it is gone its draft and
 * its side chats' drafts go too; the side chats come from `orchestration.getThreadFamily` on a server whose shell can
 * omit them, else from the local list.
 */
export async function deleteUnlistedThread(id: string): Promise<void> {
  const local = allThreads().map((item) => ({ id: item.id, sideChat: item.relations?.lineage?.sideChat === true, parentThreadId: item.relations?.lineage?.parentThreadId ?? null }));
  const sideChats = await sideChatsOfDeletedThread(id, local, requestBackend);
  await deleteThread(id);
  for (const threadId of [id, ...sideChats]) releaseThreadDraft(threadId);
}

const failureReason = (error: unknown) => (error instanceof Error && error.message ? error.message : "An error occurred.");

/**
 * Feedback for a sidebar action, raised through the shared toast host as the web's toastManager does:
 * a failure is an error toast with the title and the reason below it, a copy a success toast.
 */
export const threadActionNotice = {
  /** "Failed to settle thread" with the reason as the description. */
  failure(title: string, error?: unknown) {
    return errorToast(title, failureReason(error));
  },
  success(title: string, description?: string) {
    return showToast({ type: "success", title, ...(description ? { description } : {}) });
  },
  warning(title: string, description?: string) {
    return showToast({ type: "warning", title, ...(description ? { description } : {}) });
  },
  /** A prepared one-liner: "Title: reason" splits into title and description; "Failed ..." and "Could not ..." are errors. */
  show(message: string) {
    const split = message.indexOf(": ");
    const title = split > 0 ? message.slice(0, split) : message;
    const description = split > 0 ? message.slice(split + 2) : undefined;
    if (/^(Failed|Could not|Cannot|Unable)\b/.test(title)) return errorToast(title, description ?? "An error occurred.");
    return showToast({ type: "info", title, ...(description ? { description } : {}) });
  },
};

export type ThreadUndoAction = "Settled" | "Snoozed" | "Unpinned" | "Archived";
/** showThreadUndoNotice's `failureTitle`: "Failed to undo archive", "... settle", "... unpin", "... snooze". */
const UNDO_VERB: Record<ThreadUndoAction, string> = { Settled: "settle", Snoozed: "snooze", Unpinned: "unpin", Archived: "archive" };
interface UndoNotice { action: ThreadUndoAction; count: number; undo: () => Promise<unknown> }
const undoNotice = signal<UndoNotice | null>(null);
setThreadUndoRunner(() => { if (!undoNotice()) return false; releaseThreadUndoShortcut(); void threadUndo.run(); return true; });
let undoTimer: ReturnType<typeof setTimeout> | undefined;

// client-runtime threadUndo.ts: one claim per (kind, thread); a newer action of a kind, or an action that supersedes it,
// makes the older Undo stale, and a stale Undo leaves the notice (claim.isCurrent, ThreadUndo.invalidate).
const UNDO_KIND: Record<ThreadUndoAction, string> = { Settled: "settle", Snoozed: "snooze", Unpinned: "pin", Archived: "archive" };
const currentClaims = new Map<string, symbol>();
interface UndoClaim { isCurrent: () => boolean; finish: () => void }
export function beginThreadUndo(kind: string, threadId: string): UndoClaim {
  const key = JSON.stringify([kind, threadId]);
  const token = Symbol();
  currentClaims.set(key, token);
  refreshUndoNotice();
  const isCurrent = () => currentClaims.get(key) === token;
  return { isCurrent, finish: () => { if (isCurrent()) { currentClaims.delete(key); refreshUndoNotice(); } } };
}
/** ThreadUndo.invalidate for each kind on one thread. */
export function expireThreadUndos(threadId: string, kinds: readonly string[]) {
  for (const kind of kinds) currentClaims.delete(JSON.stringify([kind, threadId]));
  refreshUndoNotice();
}
/** useThreadActions: archiving or deleting ends the list-placement undos; settling supersedes pin and snooze ones. */
export const LIST_PLACEMENT_UNDO_KINDS = ["settle", "snooze", "pin"] as const;
const SUPERSEDES: Record<ThreadUndoAction, readonly string[]> = { Settled: ["pin", "snooze"], Snoozed: [], Unpinned: [], Archived: LIST_PLACEMENT_UNDO_KINDS };

interface LiveUndo { action: ThreadUndoAction; undo: () => Promise<unknown>; claim: UndoClaim }
let liveUndos: LiveUndo[] = [];

/** showThreadUndoNotice refreshNotice: stale entries drop out; the newest run of one action is the notice. */
function refreshUndoNotice() {
  liveUndos = liveUndos.filter((entry) => entry.claim.isCurrent());
  const latest = liveUndos.at(-1);
  if (!latest) { clearTimeout(undoTimer); undoNotice.set(null); return; }
  const group: LiveUndo[] = [];
  for (let index = liveUndos.length - 1; index >= 0; index--) {
    const entry = liveUndos[index]!;
    if (entry.action !== latest.action) break;
    group.push(entry);
  }
  undoNotice.set({
    action: latest.action,
    count: group.length,
    undo: async () => {
      const current = group.filter((entry) => liveUndos.includes(entry) && entry.claim.isCurrent());
      liveUndos = liveUndos.filter((entry) => !group.includes(entry));
      for (const entry of current) entry.claim.finish();
      refreshUndoNotice();
      await Promise.all(current.map((entry) => entry.undo()));
    },
  });
}

/** The compact "Archived, Undo" the footer shows after a reversible thread action (showThreadUndoNotice). */
export const threadUndo = {
  notice: () => undoNotice(),
  /** Repeated actions of one kind group into one notice with a count. `threadId` keys the claim that can expire it. */
  show(action: ThreadUndoAction, undo: () => Promise<unknown>, threadId?: string) {
    if (threadId) expireThreadUndos(threadId, SUPERSEDES[action]);
    const claim: UndoClaim = threadId ? beginThreadUndo(UNDO_KIND[action], threadId) : { isCurrent: () => true, finish: () => {} };
    liveUndos.push({ action, undo, claim });
    refreshUndoNotice();
    const notice = undoNotice()!;
    // setNotice: the notice is announced on its own (settling moves the focus at the same moment), as the full sentence.
    announce(`${threadUndo.announcement({ action, count: notice.count })}, ${threadUndo.label()}`);
    claimThreadUndoShortcut();
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { liveUndos = []; undoNotice.set(null); }, 5000);
  },
  /** Runs the undo, clearing the notice first so a second press cannot restore twice. */
  async run() {
    const current = undoNotice();
    if (!current) return;
    clearTimeout(undoTimer);
    undoNotice.set(null);
    try {
      await current.undo();
    } catch (error) {
      threadActionNotice.failure(`Failed to undo ${UNDO_VERB[current.action]}`, error);
    }
  },
  summary(notice: { action: ThreadUndoAction; count: number }) {
    return notice.count === 1 ? notice.action : `${notice.action} ${notice.count}`;
  },
  /** threadUndoNoticeSummary: what a screen reader hears ("Settled 2 threads"). */
  announcement(notice: { action: ThreadUndoAction | "Discarded"; count: number }) {
    const noun = notice.action === "Discarded" ? "draft" : "thread";
    return `${notice.action} ${notice.count} ${noun}${notice.count === 1 ? "" : "s"}`;
  },
  /** threadUndoLabel: "⌘Z to undo" from the resolved binding, else "Undo". */
  label() {
    const shortcut = shortcutLabel("thread.undo");
    return shortcut ? `${shortcut} to undo` : "Undo";
  },
};

const archiving = signal<string[]>([]);
export const isArchiving = (id: string) => archiving().includes(id);

/** The web's `api.dialogs.confirm([question, detail].join("\n"))`, through the shared dialog host. */
async function confirm(title: string, description: string, _action: string, destructive: boolean): Promise<boolean> {
  return askConfirm([title, description].filter((line) => line.length > 0).join("\n"), { variant: destructive ? "destructive" : "default" });
}

export interface ThreadActionContext {
  thread: Thread;
  /** Starts inline rename on the row. */
  startRename: () => void;
  /** Opens the custom snooze dialog; resolves to an ISO time or null. */
  requestCustomSnooze: () => Promise<string | null>;
  presets: readonly SnoozePreset[];
  projectPath?: string;
  /** Narrows the sidebar to the thread's project, or back to all of them. */
  toggleProjectFilter?: () => void;
  /** Creates a draft in the thread's project on `branch` (in the thread's worktree when it has one); a throw is a failure. */
  newThreadOnBranch: (branch: string, worktreePath: string | null) => void | Promise<void>;
}

/**
 * useThreadActionMenu "new-thread-on-branch": handleNewThread(project, { branch, worktreePath, envMode: worktreePath ?
 * "worktree" : "local", startFromOrigin: false }), as the draft's workspace strategy from the start.
 */
export function createThreadOnBranch(projectId: string | null, branch: string, worktreePath: string | null): void {
  const workspace = validWorkspaceStrategy(worktreePath
    ? { type: "existing_worktree", worktreePath, branch }
    : { type: "root", branch });
  createThread(projectId, { workspace });
}

async function copyText(text: string, done: string, failed: string) {
  try {
    await Clipboard.writeText(text);
    threadActionNotice.success(done, text.length <= 200 ? text : undefined);
  } catch (error) {
    threadActionNotice.failure(failed, error);
  }
}

/** Runs one chosen menu id, as the Sidebar.tsx handler switch does. */
export async function runThreadAction(id: ThreadMenuId, context: ThreadActionContext): Promise<void> {
  const { thread } = context;
  const fail = (title: string) => (error: unknown) => {
    threadActionNotice.failure(title, error);
  };
  if (id.startsWith("snooze:") && id !== "snooze:custom") {
    const preset = context.presets.find((candidate) => `snooze:${candidate.id}` === id);
    if (!preset) {
      threadActionNotice.failure("Could not snooze thread", new Error("That snooze time has passed. Choose another time."));
      return;
    }
    if (Date.parse(preset.snoozedUntil) <= Date.now()) {
      threadActionNotice.failure("Could not snooze thread", new Error("That snooze time has passed. Choose another time."));
      return;
    }
    await snoozeThread(thread.id, preset.snoozedUntil)
      .then(() => threadUndo.show("Snoozed", () => unsnoozeThread(thread.id), thread.id))
      .catch(fail("Failed to snooze thread"));
    return;
  }
  switch (id) {
    case "snooze:custom": {
      const until = await context.requestCustomSnooze();
      if (until) {
        await snoozeThread(thread.id, until)
          .then(() => threadUndo.show("Snoozed", () => unsnoozeThread(thread.id), thread.id))
          .catch(fail("Failed to snooze thread"));
      }
      return;
    }
    case "share-guest":
      openGuestShareDialog(thread.id);
      return;
    case "find":
      // The thread view registers the find command; the menu goes through the registry.
      runCommand("chat.find");
      return;
    case "unsnooze":
      await unsnoozeThread(thread.id).catch(fail("Failed to wake thread"));
      return;
    case "pin":
      // Pinning clears snooze, so older Settled or Snoozed undos would fight this pin.
      expireThreadUndos(thread.id, ["pin", "settle", "snooze"]);
      setThreadPinned(thread.id, true);
      return;
    case "unpin":
      await unpinThreadWithUndo(thread);
      return;
    case "settle":
      await settleThread(thread.id)
        .then(() => threadUndo.show("Settled", () => unsettleThread(thread.id), thread.id))
        .catch(fail("Failed to settle thread"));
      return;
    case "unsettle":
      await unsettleThread(thread.id).catch(fail("Failed to un-settle thread"));
      return;
    case "rename":
      context.startRename();
      return;
    case "regenerate-title":
      await regenerateThreadTitle(thread.id).catch(fail("Failed to regenerate thread title"));
      return;
    case "mark-unread":
      await markThreadUnread(thread.id).catch(fail("Failed to mark thread unread"));
      return;
    case "new-thread-on-branch": {
      const branch = thread.meta?.branch;
      if (!branch) return;
      try {
        await context.newThreadOnBranch(branch, thread.path ?? null);
      } catch (error) {
        fail("Could not create thread")(error);
      }
      return;
    }
    case "copy-path": {
      const path = thread.path ?? context.projectPath;
      if (!path) {
        threadActionNotice.failure("Path unavailable", new Error("This thread does not have a workspace path to copy."));
        return;
      }
      await copyText(path, "Path copied", "Failed to copy path");
      return;
    }
    case "copy-branch":
      if (thread.meta?.branch) await copyText(thread.meta.branch, "Branch copied", "Failed to copy branch");
      return;
    case "copy-thread": {
      const environment = environmentId();
      if (!environment) {
        threadActionNotice.failure("Failed to copy thread", new Error("This environment has no id yet."));
        return;
      }
      await copyText(hostedThreadLink(environment, thread.id), "Thread copied", "Failed to copy thread");
      return;
    }
    case "copy-thread-id":
      await copyText(thread.id, "Thread ID copied", "Failed to copy thread ID");
      return;
    case "filter-by-project":
      context.toggleProjectFilter?.();
      return;
    case "turn-into-project":
      await requestBackend("projects.createFromThread", { threadId: thread.id })
        .then(() => threadActionNotice.success("Project created", thread.title))
        .catch(fail("Could not turn thread into a project"));
      return;
    case "auto-settle:enabled":
    case "auto-settle:disabled":
      await dispatchThreadCommand({ type: "thread.auto-settle.set", threadId: thread.id, enabled: id === "auto-settle:enabled" })
        .catch(fail("Failed to update auto-settle"));
      return;
    case "project-settings":
      if (thread.projectId) showSidebarProjectSettings(thread.projectId);
      else openSettings("/settings/projects");
      return;
    case "archive":
      if (confirmsArchive() && !(await confirm(`Archive thread "${thread.title}"?`, "", "Archive", false))) return;
      {
        const blocked = archiveBlockedReason(thread);
        if (blocked) { fail("Failed to archive thread")(new Error(blocked)); return; }
      }
      if (isArchiving(thread.id)) return;
      archiving.update((ids) => [...ids, thread.id]);
      try {
        await archiveThread(thread.id)
          .then(() => threadUndo.show("Archived", () => { expireThreadUndos(thread.id, ["archive"]); return restoreThread(thread.id); }, thread.id))
          .catch(fail("Failed to archive thread"));
      } finally {
        archiving.update((ids) => ids.filter((id) => id !== thread.id));
      }
      return;
    case "delete":
      if (confirmsDelete() && !(await confirm(
        `Delete thread "${thread.title}"?`,
        "This permanently clears conversation history for this thread.",
        "Delete",
        true,
      ))) return;
      {
        // useThreadActions: the thread that opens once the open one is gone follows sidebarThreadSortOrder.
        const wasOpen = openThread()?.id === thread.id;
        const fallbackId = wasOpen ? fallbackThreadIdAfterDelete({ threads: allThreads(), deletedId: thread.id }) : null;
        const deleted = await deleteThreadWithWorktree(thread).then(() => true, (error: unknown) => { fail("Failed to delete thread")(error); return false; });
        if (deleted && fallbackId !== null && (openThread() === undefined || openThread()?.id === thread.id)) openThreadById(fallbackId);
      }
      return;
    default:
      return;
  }
}

/** Builds the menu state for a thread from the store's row data. */
export function threadMenuState(input: {
  thread: Thread;
  now: number;
  connected: boolean;
  hasProject: boolean;
  presets: readonly SnoozePreset[];
  /** The thread's project: its name for the filter item, its folder for Turn into project. */
  project?: { id: string; name: string; path?: string };
  scopeIds?: readonly string[];
  canFind?: boolean;
  /** The title menu (useThreadActionMenu) passes `projectFilter: null`: only the sidebar row offers Filter by <project>. */
  omitProjectFilter?: boolean;
}): ThreadMenuState {
  const { thread } = input;
  const meta = thread.meta;
  const running = thread.status === "running" || thread.status === "awaiting";
  return {
    branch: meta?.branch ?? null,
    hasPath: Boolean(thread.path) || input.hasProject,
    hasProject: input.hasProject,
    canFind: input.canFind === true,
    canShareWithGuest: canShareWithGuest({ settings: serverSettings(), managedPolicy: serverManagedPolicy(), connected: input.connected }),
    isPinned: thread.pinned,
    isSettled: meta?.settled === true,
    isSnoozed: isSnoozed(thread, input.now),
    canSnoozeNow: canSnooze(thread, input.now),
    isRegeneratingTitle: meta?.titleRegenerating === true,
    isRunning: running,
    isArchiving: isArchiving(thread.id),
    supports: {
      settlement: input.connected, snooze: input.connected, pinning: input.connected, titleRegeneration: input.connected,
      autoSettleOptOut: input.connected && supportsAutoSettleOptOut(),
    },
    snoozePresets: input.presets,
    projectFilter: input.project && input.omitProjectFilter !== true ? { label: input.project.name, isActive: (input.scopeIds ?? []).includes(input.project.id) } : null,
    autoSettleEnabled: meta?.autoSettleDisabled !== true,
    canTurnIntoProject: input.connected && canTurnThreadIntoProject(thread, input.project?.path),
  };
}

// --- The menu a right-click on a selected row opens (handleMultiSelectContextMenu) --------------

export interface BulkMenuState {
  count: number;
  pinnedCount: number;
  /** How many of the selection are not settled yet. */
  settlingCount: number;
  canSnooze: boolean;
  snoozePresets: readonly SnoozePreset[];
  /** Threads whose title can be regenerated, and those not already regenerating. */
  titleSupportedCount: number;
  titleActionableCount: number;
  connected: boolean;
}

/** The bulk items: Unpin, Settle, Snooze, Regenerate titles, Mark unread, Delete, each with its count. */
export function buildBulkMenu(state: BulkMenuState): ThreadMenuItem[] {
  const writable = state.connected;
  return [
    ...(state.pinnedCount > 0 ? [{ id: "bulk:unpin" as const, label: `Unpin (${state.pinnedCount})`, disabled: !writable }] : []),
    { id: "bulk:settle" as const, label: `Settle (${state.count})`, disabled: state.settlingCount === 0 || !writable },
    ...(state.canSnooze
      ? [{
        id: "bulk:snooze" as const,
        label: `Snooze (${state.count})`,
        disabled: !writable,
        children: [
          ...state.snoozePresets.map((preset) => ({ id: `bulk:snooze:${preset.id}` as const, label: `${preset.label} (${preset.whenLabel})`, disabled: !writable })),
          { id: "bulk:snooze:custom" as const, label: "Custom…", separatorBefore: state.snoozePresets.length > 0, disabled: !writable },
        ],
      }]
      : []),
    ...(state.titleSupportedCount > 0
      ? [state.titleActionableCount === 0
        ? { id: "bulk:regenerate-title" as const, label: `Regenerating… (${state.titleSupportedCount})`, disabled: true }
        : { id: "bulk:regenerate-title" as const, label: `Regenerate titles (${state.titleActionableCount})`, disabled: !writable }]
      : []),
    { id: "bulk:mark-unread" as const, label: `Mark unread (${state.count})` },
    { id: "bulk:delete" as const, label: `Delete (${state.count})`, destructive: true, disabled: !writable },
  ];
}

export function bulkMenuState(threads: readonly Thread[], presets: readonly SnoozePreset[], connected: boolean): BulkMenuState {
  const regenerating = (thread: Thread) => thread.meta?.titleRegenerating === true;
  return {
    count: threads.length,
    pinnedCount: threads.filter((thread) => thread.pinned).length,
    settlingCount: threads.filter((thread) => thread.meta?.settled !== true).length,
    canSnooze: threads.every((thread) => canSnooze(thread, Date.now())),
    snoozePresets: presets,
    titleSupportedCount: connected ? threads.length : 0,
    titleActionableCount: connected ? threads.filter((thread) => !regenerating(thread)).length : 0,
    connected,
  };
}

/** Runs one bulk item on the selected threads, then clears the selection as the web does. */
export async function runBulkAction(id: ThreadMenuId, threads: readonly Thread[], context: {
  presets: readonly SnoozePreset[];
  requestCustomSnooze: () => Promise<string | null>;
}): Promise<void> {
  const failed: unknown[] = [];
  const each = async (targets: readonly Thread[], run: (thread: Thread) => Promise<unknown>) => {
    const results = await Promise.allSettled(targets.map(run));
    for (const result of results) if (result.status === "rejected") failed.push(result.reason);
  };
  const report = (title: string) => {
    if (failed.length === 0) return;
    const first = failed[0];
    threadActionNotice.failure(title, first);
  };
  if (id.startsWith("bulk:snooze:")) {
    let until: string | null = null;
    if (id === "bulk:snooze:custom") until = await context.requestCustomSnooze();
    else {
      const preset = context.presets.find((candidate) => `bulk:snooze:${candidate.id}` === id);
      if (preset && Date.parse(preset.snoozedUntil) > Date.now()) until = preset.snoozedUntil;
      else threadActionNotice.failure("Could not snooze thread", new Error("That snooze time has passed. Choose another time."));
    }
    if (until === null) return;
    const wake = until;
    clearThreadSelection();
    await each(threads, (thread) => snoozeThread(thread.id, wake));
    report(failed.length < threads.length ? `Failed to snooze ${failed.length} thread${failed.length === 1 ? "" : "s"}` : "Failed to snooze threads");
    return;
  }
  switch (id) {
    case "bulk:unpin":
      for (const thread of threads.filter((item) => item.pinned)) setThreadPinned(thread.id, false);
      clearThreadSelection();
      return;
    case "bulk:settle":
      await each(threads.filter((thread) => thread.meta?.settled !== true), (thread) => settleThread(thread.id));
      clearThreadSelection();
      report("Failed to settle thread");
      return;
    case "bulk:regenerate-title":
      await each(threads.filter((thread) => thread.meta?.titleRegenerating !== true), (thread) => regenerateThreadTitle(thread.id));
      clearThreadSelection();
      report("Failed to regenerate thread titles");
      return;
    case "bulk:mark-unread":
      await each(threads, (thread) => markThreadUnread(thread.id));
      clearThreadSelection();
      report("Failed to mark thread unread");
      return;
    case "bulk:delete": {
      const count = threads.length;
      if (confirmsDelete() && !(await confirm(
        `Delete ${count} thread${count === 1 ? "" : "s"}?`,
        "This permanently clears conversation history for these threads.",
        "Delete",
        true,
      ))) return;
      const deleted: string[] = [];
      const going = new Set(threads.map((thread) => thread.id));
      for (const thread of threads) {
        try {
          await deleteThreadWithWorktree(thread, going);
          deleted.push(thread.id);
        } catch (error) {
          failed.push(error);
          break;
        }
      }
      report("Failed to delete threads");
      removeFromSelection(deleted);
      return;
    }
    default:
      return;
  }
}
