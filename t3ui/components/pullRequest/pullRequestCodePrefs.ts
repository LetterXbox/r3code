// What the Code tab remembers between visits (useHideTestFiles, PULL_REQUEST_FILE_TREE_STORAGE_KEY and the
// file tree's saved width in PullRequestCodeTab.tsx): hiding test files and the tree's width are shared with the
// diff panel's keys, the pull request file tree's open state is its own.
import { signal, Storage } from "nsh";
import { readSavedTreeWidth } from "../diff/treeWidth";

export const hideTestFiles = signal(false);
export const fileTreeOpen = signal(false);
export const savedTreeWidth = signal<number | null>(null);

let loaded = false;
function persist(key: string, value: string) { void Storage.setItem(key, value).catch(() => {}); }
export function setHideTestFiles(value: boolean) { loaded = true; hideTestFiles.set(value); persist("diffHideTestFiles", value ? "true" : "false"); }
export function setFileTreeOpen(value: boolean) { loaded = true; fileTreeOpen.set(value); persist("pullRequestFileTreeOpen", value ? "true" : "false"); }
export function setSavedTreeWidth(value: number) { savedTreeWidth.set(value); persist("diffFileTreeWidth", String(value)); }

void Promise.all([Storage.getItem("diffHideTestFiles"), Storage.getItem("pullRequestFileTreeOpen"), Storage.getItem("diffFileTreeWidth")]).then(([tests, tree, width]) => {
  if (!loaded) {
    if (tests === "true") hideTestFiles.set(true);
    if (tree === "true") fileTreeOpen.set(true);
  }
  if (savedTreeWidth() === null) savedTreeWidth.set(readSavedTreeWidth(width));
}).catch(() => {}).finally(() => { loaded = true; });
