// OpenInPicker.tsx's option list and preferred-editor rule. Editor ids and
// labels are EDITORS in packages/contracts/src/editor.ts, in that order.

const EDITOR_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["cursor", "Cursor"], ["trae", "Trae"], ["kiro", "Kiro"], ["vscode", "VS Code"], ["vscode-insiders", "VS Code Insiders"],
  ["vscodium", "VSCodium"], ["zed", "Zed"], ["antigravity", "Antigravity"], ["idea", "IntelliJ IDEA"], ["aqua", "Aqua"],
  ["clion", "CLion"], ["datagrip", "DataGrip"], ["dataspell", "DataSpell"], ["goland", "GoLand"], ["phpstorm", "PhpStorm"],
  ["pycharm", "PyCharm"], ["rider", "Rider"], ["rubymine", "RubyMine"], ["rustrover", "RustRover"], ["webstorm", "WebStorm"],
  ["file-manager", "File Manager"],
];

export interface OpenInOption { value: string; label: string }

export function fileManagerName(os: string): string {
  return os === "macos" || os === "ios" ? "Finder" : os === "windows" ? "File Explorer" : "Files";
}

export function editorLabel(editor: string, os: string): string {
  if (editor === "file-manager") return fileManagerName(os);
  return EDITOR_LABELS.find(([id]) => id === editor)?.[1] ?? "Editor";
}

/** The installed editors in the web's order, labelled for the platform. */
export function resolveOpenInOptions(os: string, available: ReadonlyArray<string>): OpenInOption[] {
  const set = new Set(available);
  return EDITOR_LABELS.filter(([id]) => set.has(id)).map(([id]) => ({ value: id, label: editorLabel(id, os) }));
}

/** usePreferredEditor: the last one used while it is still installed, else the first installed. */
export function effectiveEditor(last: string | null, available: ReadonlyArray<string>): string | null {
  if (last && available.includes(last)) return last;
  return EDITOR_LABELS.find(([id]) => available.includes(id))?.[0] ?? null;
}

/**
 * OpenInPicker.logic.ts shouldShowOpenInPicker: a project name is needed; a thread of the primary environment always shows it,
 * a thread of another machine only when it can open remotely (its remote-open mode is not the local launch).
 */
export function shouldShowOpenInPicker(input: { activeProjectName: string | undefined; activeThreadEnvironmentId: string | null; primaryEnvironmentId: string | null; remoteOpenMode: "local-exec" | "remote-links" | "remote-unavailable" }): boolean {
  if (!input.activeProjectName) return false;
  if (input.primaryEnvironmentId !== null && input.activeThreadEnvironmentId === input.primaryEnvironmentId) return true;
  return input.remoteOpenMode !== "local-exec";
}

export function openInButtonLabel(option: OpenInOption | null): string {
  return `Open in ${option?.label ?? "editor"}`;
}

/** Reads `availableEditors` out of a server.getConfig result. */
export function readAvailableEditors(config: unknown): string[] {
  if (typeof config !== "object" || config === null) return [];
  const editors = (config as Record<string, unknown>).availableEditors;
  return Array.isArray(editors) ? editors.filter((item): item is string => typeof item === "string") : [];
}
