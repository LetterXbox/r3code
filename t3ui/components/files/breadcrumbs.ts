// FileBreadcrumbs.tsx's rules (files/filePath.ts): the crumbs of a path, the sibling-folder menu's rows and its Back item.
import { isHostPath } from "./explorerState";
import { compareEntries, type FileEntry } from "./filesLogic";

/** fileBreadcrumbs for a path outside the workspace (files/filePath.ts): no project crumb, the root kept in each crumb's path. */
export function hostBreadcrumbs(path: string): FileBreadcrumb[] {
  const windows = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
  const separator = windows ? "\\" : "/";
  const parts = path.split(/[\\/]/).filter(Boolean);
  const root = path.startsWith("\\\\") ? "\\\\" : path.startsWith("/") ? "/" : "";
  return parts.map((label, index) => {
    const joined = root + parts.slice(0, index + 1).join(separator);
    // A bare drive (`C:`) means the drive's current directory; its root is `C:\`. A bare `~` is the home folder `~/`.
    return { label, path: /^[A-Za-z]:$/.test(joined) ? `${joined}\\` : joined === "~" ? "~/" : joined };
  });
}

export interface FileBreadcrumb { label: string; path: string }

/** The project, then each folder and the file: `""` is the workspace root. */
export function fileBreadcrumbs(projectName: string, path: string): FileBreadcrumb[] {
  if (isHostPath(path)) return hostBreadcrumbs(path);
  const crumbs: FileBreadcrumb[] = [{ label: projectName, path: "" }];
  const parts = path.split("/").filter(Boolean);
  parts.forEach((label, index) => crumbs.push({ label, path: parts.slice(0, index + 1).join("/") }));
  return crumbs;
}

export function breadcrumbParent(path: string): string | null {
  if (path === "") return null;
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

export function breadcrumbLabel(path: string, projectName: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || projectName;
}

/** The direct children of `directoryPath` in the listing's order (folders first). */
export function breadcrumbChildren(entries: readonly FileEntry[], directoryPath: string): FileEntry[] {
  return entries
    .filter((entry) => breadcrumbParent(entry.path) === directoryPath)
    .sort(compareEntries);
}

export interface BreadcrumbMenuRow { label: string; path: string; kind: "file" | "directory" | "back" | "info"; current?: boolean; ignored?: boolean; disabled?: boolean }

/**
 * The rows of a crumb's menu: a Back row once the menu has gone into a subfolder of the crumb it opened for,
 * then the folder's children, or the reference's one-line states.
 */
export function breadcrumbMenuRows(input: { directoryPath: string; rootPath: string; projectName: string; currentFilePath: string; entries: readonly FileEntry[] | null; truncated: boolean; failed: boolean; /** The last listing is shown, but reading it again failed. */ refreshFailed?: boolean }): BreadcrumbMenuRow[] {
  const rows: BreadcrumbMenuRow[] = [];
  const parent = breadcrumbParent(input.directoryPath);
  const canGoBack = input.directoryPath !== input.rootPath && parent !== null && (input.rootPath === "" || parent === input.rootPath || parent.startsWith(`${input.rootPath}/`));
  if (canGoBack && parent !== null) rows.push({ label: `Back to ${breadcrumbLabel(parent, input.projectName)}`, path: parent, kind: "back" });
  if (input.entries === null) {
    rows.push({ label: input.failed ? "Retry loading folder" : "Loading folder…", path: input.directoryPath, kind: "info", disabled: !input.failed });
    return rows;
  }
  const children = breadcrumbChildren(input.entries, input.directoryPath);
  if (children.length === 0) {
    rows.push({ label: input.truncated ? "No entries from this folder are available in the partial workspace index." : "This folder is empty.", path: input.directoryPath, kind: "info", disabled: true });
  } else {
    for (const entry of children) rows.push({ label: entry.name, path: entry.path, kind: entry.kind, current: entry.kind === "file" && entry.path === input.currentFilePath, ignored: entry.ignored });
  }
  if (input.refreshFailed) rows.push({ label: "Refresh failed. Retry", path: input.directoryPath, kind: "info" });
  if (input.truncated && children.length > 0) rows.push({ label: "Some workspace entries are not shown.", path: input.directoryPath, kind: "info", disabled: true });
  return rows;
}
