// The file tab's side explorer (FilePreviewPanel.tsx explorerOpen with FILE_EXPLORER_STORAGE_KEY, files/FileExplorerPane.tsx):
// whether it is shown, how wide it is, and when it is shown at all. Both settings are remembered across restarts.
import { signal, Storage } from "nsh";

const OPEN_KEY = "t3code.fileExplorerOpen";
const WIDTH_KEY = "t3code.fileExplorerWidth";

export const EXPLORER_MIN_WIDTH = 160;
export const EXPLORER_MAX_WIDTH = 560;
export const EXPLORER_DEFAULT_WIDTH = 256;
/** FILE_CONTENT_MIN_WIDTH: the file keeps at least this much of the row beside the explorer. */
export const FILE_CONTENT_MIN_WIDTH = 256;

const open = signal(true);
const width = signal(EXPLORER_DEFAULT_WIDTH);
let touched = false;
let loaded = false;

/** The explorer is shown (the web default is open). */
export const explorerOpen = () => open();
export const explorerWidth = () => width();

function load() {
  if (loaded) return;
  loaded = true;
  void Storage.getItem(OPEN_KEY).then((text) => { if (!touched && text === "false") open.set(false); }).catch(() => {});
  void Storage.getItem(WIDTH_KEY).then((text) => {
    const value = Number(text);
    if (!touched && text && Number.isFinite(value)) width.set(clampExplorerWidth(value, EXPLORER_MAX_WIDTH));
  }).catch(() => {});
}
load();

export function setExplorerOpen(next: boolean) {
  touched = true;
  open.set(next);
  void Storage.setItem(OPEN_KEY, String(next)).catch(() => {});
}

export function toggleExplorer() {
  setExplorerOpen(!open());
}

export function setExplorerWidth(next: number) {
  touched = true;
  width.set(next);
  void Storage.setItem(WIDTH_KEY, String(next)).catch(() => {});
}

/** The widest the explorer gets in a row `rowWidth` wide: 560, and never so wide the file drops under 256. */
export function explorerMaxWidth(rowWidth: number): number {
  return Math.max(EXPLORER_MIN_WIDTH, Math.min(EXPLORER_MAX_WIDTH, Math.floor(rowWidth) - FILE_CONTENT_MIN_WIDTH));
}

export function clampExplorerWidth(value: number, max: number): number {
  const wanted = Number.isFinite(value) ? value : EXPLORER_DEFAULT_WIDTH;
  return Math.round(Math.max(EXPLORER_MIN_WIDTH, Math.min(wanted, max)));
}

/** FileExplorerPane's resize separator keys: Left widens and Right narrows by 16, Home is the minimum, End the maximum. */
export const EXPLORER_KEYS = ["left", "right", "home", "end"] as const;
export function explorerKeyWidth(key: (typeof EXPLORER_KEYS)[number], width: number, max: number): number {
  const next = key === "left" ? width + 16 : key === "right" ? width - 16 : key === "home" ? EXPLORER_MIN_WIDTH : max;
  return clampExplorerWidth(next, max);
}

/** A path outside the workspace: absolute, home-relative or a drive (isHostPath in packages/shared/src/path.ts). */
export function isHostPath(path: string): boolean {
  return path.startsWith("/") || path === "~" || path.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** shouldShowFileExplorer: not beside an attachment or a host file; beside a workspace file while open, and always where no file is open. */
export function shouldShowFileExplorer(input: { relativePath: string | null; explorerOpen: boolean; attachmentOpen: boolean }): boolean {
  if (input.attachmentOpen || (input.relativePath && isHostPath(input.relativePath))) return false;
  return input.explorerOpen || input.relativePath === null;
}
