// The files context menu (FileBrowserPanel.tsx's showEntryContextMenu + fileContextMenu.ts): Open, Reveal, Open with,
// Copy mention, Add to chat. Pure item building, and the actions through the real `shell.openInEditor` contract.
import { Clipboard } from "nsh";
import { editorLabel, fileManagerName } from "../header/openInLogic";

export interface FileMenuCapabilities {
  os: string;
  /** server.getConfig availableEditors. */
  editors: readonly string[];
  /** server.getConfig shellRevealInFileManager. */
  canReveal: boolean;
  /** server.getConfig shellRevealInFileManagerKind: WSL reveals in Windows Explorer while reporting Linux. */
  revealKind?: string;
}

/** revealInFileExplorerLabelForKind / ForOs (components/preview/fileExplorerLabel.ts). */
export function revealLabel(capabilities: FileMenuCapabilities): string {
  if (capabilities.revealKind === "finder") return "Reveal in Finder";
  if (capabilities.revealKind === "file-explorer") return "Reveal in File Explorer";
  if (capabilities.revealKind !== undefined) return "Reveal in Files";
  return `Reveal in ${fileManagerName(capabilities.os)}`;
}

/** The error toast's title for a failed action (fileContextMenu.ts activate, FileBrowserPanel's copy and add). */
export function fileActionFailureTitle(action: FileMenuAction, os: string): string {
  if (action.id === "open") return "Could not open file";
  if (action.id === "reveal") return "Unable to reveal file";
  if (action.id === "editor") return `Could not open in ${editorLabel(action.editor, os)}`;
  if (action.id === "copy-mention") return "Failed to copy mention";
  return "Unable to add to chat";
}

export type FileMenuAction = { id: "open" } | { id: "reveal" } | { id: "editor"; editor: string } | { id: "copy-mention" } | { id: "add-to-chat" };

export interface FileMenuItem { label: string; action?: FileMenuAction; children?: FileMenuItem[] }

/** The reference's order: Open, Reveal in <file manager>, Open with > editors, then Copy mention and Add to chat. */
export function fileMenuItems(capabilities: FileMenuCapabilities, options: { mentions?: boolean } = {}): FileMenuItem[] {
  const items: FileMenuItem[] = [];
  const manager = capabilities.editors.includes("file-manager");
  if (manager) items.push({ label: "Open", action: { id: "open" } });
  if (manager && capabilities.canReveal) items.push({ label: revealLabel(capabilities), action: { id: "reveal" } });
  const editors = capabilities.editors.filter((id) => id !== "file-manager");
  if (editors.length > 0) items.push({ label: "Open with", children: editors.map((editor) => ({ label: editorLabel(editor, capabilities.os), action: { id: "editor", editor } })) });
  if (options.mentions !== false) items.push({ label: "Copy mention", action: { id: "copy-mention" } }, { label: "Add to chat", action: { id: "add-to-chat" } });
  return items;
}

/** `shell.openInEditor`'s input for an action (LaunchEditorInput), or null for the actions that are not launches. */
export function launchInput(action: FileMenuAction, absolutePath: string): { cwd: string; editor: string; reveal?: boolean } | null {
  if (action.id === "open") return { cwd: absolutePath, editor: "file-manager" };
  if (action.id === "reveal") return { cwd: absolutePath, editor: "file-manager", reveal: true };
  if (action.id === "editor") return { cwd: absolutePath, editor: action.editor };
  return null;
}

export function absoluteFilePath(cwd: string, relativePath: string): string {
  if (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(relativePath)) return relativePath;
  return `${cwd.replace(/\/+$/, "")}/${relativePath.replace(/^\/+/, "")}`;
}

/** The text appended to a draft for a mention: one space between, one after, as insertTextAtEnd with a leading boundary does. */
export function draftWithMention(draft: string, mention: string): string {
  const separator = draft === "" || /\s$/.test(draft) ? "" : " ";
  return `${draft}${separator}${mention} `;
}

type Rpc = (method: string, payload: unknown) => Promise<unknown>;

export async function runLaunch(action: FileMenuAction, absolutePath: string, rpc: Rpc): Promise<void> {
  const input = launchInput(action, absolutePath);
  if (input) await rpc("shell.openInEditor", input);
}

export async function copyMention(mention: string): Promise<void> { await Clipboard.writeText(mention); }

/** `availableEditors` and the reveal capability out of a server.getConfig result. */
export function readMenuCapabilities(config: unknown, os: string): FileMenuCapabilities {
  const value = typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
  const editors = Array.isArray(value.availableEditors) ? value.availableEditors.filter((item): item is string => typeof item === "string") : [];
  return { os, editors, canReveal: value.shellRevealInFileManager === true, ...(typeof value.shellRevealInFileManagerKind === "string" ? { revealKind: value.shellRevealInFileManagerKind } : {}) };
}
