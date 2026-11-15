// Runs the files context menu's actions against the app (clipboard, composer, server). The rules are in fileActions.ts.
import { platform, Storage } from "nsh";
import { backendBearer, backendUrl, composerDraft, openThread, requestBackend, setComposerDraft } from "../../store";
import { fetchSessionGrant, parseSessionGrant, sessionGrantsScope } from "../../backend/providers";
import { showToast } from "../toast";
import { rememberMention } from "../composer/contextChips";
import { serializeComposerFileLink } from "../composer/editor/promptDocument";
import { effectiveEditor } from "../header/openInLogic";
import { absoluteFilePath, copyMention, draftWithMention, fileActionFailureTitle, fileMenuItems, readMenuCapabilities, runLaunch, type FileMenuAction, type FileMenuCapabilities, type FileMenuItem } from "./fileActions";
import { popupOverOverlay } from "./filePopup";
import type { MenuItem } from "nsh/desktop";

type Rpc = (method: string, payload: unknown) => Promise<unknown>;

let capabilitiesCache: FileMenuCapabilities | null = null;

export async function loadMenuCapabilities(rpc: Rpc = requestBackend): Promise<FileMenuCapabilities> {
  if (capabilitiesCache) return capabilitiesCache;
  try {
    capabilitiesCache = readMenuCapabilities(await rpc("server.getConfig", {}), platform.os);
    return capabilitiesCache;
  } catch {
    return readMenuCapabilities({}, platform.os);
  }
}

/** Appends the file's mention to the open thread's draft (the web's composer.insertTextAtEnd). Returns whether a chat took it. */
export function addFileToChat(relativePath: string, kind: "file" | "folder" = "file"): boolean {
  const thread = openThread();
  if (!thread) return false;
  const mention = serializeComposerFileLink(relativePath);
  setComposerDraft(draftWithMention(composerDraft(), mention));
  rememberMention(thread.id, mention, kind);
  return true;
}

export async function runFileAction(action: FileMenuAction, target: { cwd: string; relativePath: string; kind?: "file" | "folder" }, rpc: Rpc = requestBackend): Promise<string | null> {
  try {
    if (action.id === "copy-mention") { await copyMention(serializeComposerFileLink(target.relativePath)); return null; }
    if (action.id === "add-to-chat") return addFileToChat(target.relativePath, target.kind) ? null : "Open a chat for this project and try again.";
    await runLaunch(action, absoluteFilePath(target.cwd, target.relativePath), rpc);
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

function toPopup(items: readonly FileMenuItem[], run: (action: FileMenuAction) => void): MenuItem[] {
  return items.map((item) => (item.children
    ? { label: item.label, submenu: toPopup(item.children, run) }
    : { label: item.label, onSelect: () => { if (item.action) run(item.action); } }));
}

/** Runs an action and reports it as the reference does: a toast per failure (fileContextMenu.ts activate:
 * "Could not open file" / "Unable to reveal file" / "Could not open in <Editor>" with the absolute path; FileBrowserPanel's
 * "Failed to copy mention" / "Unable to add to chat"), and "Mention copied" with the path once a copy lands. */
export async function runFileActionWithFeedback(action: FileMenuAction, target: { cwd: string; relativePath: string; kind?: "file" | "folder" }, rpc: Rpc = requestBackend): Promise<string | null> {
  const failure = await runFileAction(action, target, rpc);
  if (failure === null) {
    if (action.id === "copy-mention") showToast({ type: "success", title: "Mention copied", description: target.relativePath });
    return null;
  }
  const description = action.id === "copy-mention" ? (failure || "An error occurred.")
    : action.id === "add-to-chat" ? failure
    : absoluteFilePath(target.cwd, target.relativePath);
  showToast({ type: "error", title: fileActionFailureTitle(action, platform.os), description });
  return failure;
}

/** The right-click menu of a file row or an open file. `onFailure` gets the message of an action that failed (the
 * toast is raised here). `mentions: false` leaves out Copy mention and Add to chat (the diff's file menu). */
export async function showFileMenu(target: { cwd: string; relativePath: string; kind?: "file" | "folder" }, at: { x: number; y: number }, onFailure: (message: string) => void, rpc: Rpc = requestBackend, options: { mentions?: boolean } = {}): Promise<void> {
  const capabilities = await loadMenuCapabilities(rpc);
  await popupOverOverlay(toPopup(fileMenuItems(capabilities, options), (action) => { void runFileActionWithFeedback(action, target, rpc).then((failure) => { if (failure) onFailure(failure); }); }), at, "file menu");
}

/** AuthOrchestrationOperateScope: whether this connection may open an editor on its environment (readEnvironmentScope). */
export const OPEN_EDITOR_SCOPE_MESSAGE = "This connection cannot open an editor on this environment.";
let operateAnswer: { key: string; granted: boolean } | null = null;
export async function canOperateEnvironment(): Promise<boolean> {
  const url = backendUrl();
  const bearer = backendBearer();
  if (!url || !bearer) return true;
  const key = `${url}\n${bearer}`;
  if (operateAnswer?.key === key) return operateAnswer.granted;
  try {
    const grant = await fetchSessionGrant(url, bearer);
    // An unreadable session is not a refusal: the server still checks the launch itself.
    if (grant === null) return true;
    const session = parseSessionGrant(grant);
    const granted = session === null ? true : sessionGrantsScope(session, "orchestration:operate");
    operateAnswer = { key, granted };
    return granted;
  } catch {
    return true;
  }
}

/** The editor `Open in editor` uses (resolveAndPersistPreferredEditor): the last one used while installed, else the
 * first installed (the file manager counts, as in EDITORS), which is then saved as the last one. Null when none is. */
export async function resolvePreferredEditor(rpc: Rpc = requestBackend): Promise<FileMenuAction | null> {
  const capabilities = await loadMenuCapabilities(rpc);
  const last = await Storage.getItem("lastEditor").catch(() => null);
  const editor = effectiveEditor(last ?? null, capabilities.editors);
  if (!editor) return null;
  if (editor !== last) void Storage.setItem("lastEditor", editor).catch(() => {});
  return editor === "file-manager" ? { id: "open" } : { id: "editor", editor };
}

/** The same, for callers that cannot report a failure: the file manager when nothing is installed. */
export async function preferredEditorAction(rpc: Rpc = requestBackend): Promise<FileMenuAction> {
  return (await resolvePreferredEditor(rpc)) ?? { id: "open" };
}

/** useOpenInPreferredEditor: refuses without the operate scope, fails when no editor can open it, else launches. */
export async function openInPreferredEditor(absolutePath: string, rpc: Rpc = requestBackend): Promise<void> {
  if (!(await canOperateEnvironment())) throw new Error(OPEN_EDITOR_SCOPE_MESSAGE);
  const action = await resolvePreferredEditor(rpc);
  if (!action) throw new Error(`No available editor can open ${absolutePath}.`);
  await runLaunch(action, absolutePath, rpc);
}
