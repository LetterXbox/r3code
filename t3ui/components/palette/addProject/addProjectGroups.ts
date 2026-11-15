// The rows of every Add project view: the Sources list, the folder browser (Local folder and the clone
// destination), the New project step and the repository step. Pure: the model hands in the state.
import { filterItems, type PaletteGroup, type PaletteItem } from "../paletteLogic";
import {
  buildSourceRows, filterBrowseEntries, filterPinnedBrowseEntries, getFilesystemBrowsePath, hasTrailingPathSeparator,
  isExplicitRelativeProjectPath, isWindowsPlatform, type BrowseEntry, type PublishTarget, type ReadinessOf,
} from "./addProjectLogic";

export interface BrowseListing { partialPath: string; cwd: string | null; entries: readonly BrowseEntry[]; parentPath: string }

export interface BrowseView {
  isBrowsing: boolean;
  directoryPath: string;
  filterQuery: string;
  parentPath: string | null;
  canBrowseUp: boolean;
  /** Relative paths need a project to resolve against. */
  relativeNeedsProject: boolean;
  /** The listing of this directory, once it has arrived. */
  result: BrowseListing | null;
  visibleEntries: readonly BrowseEntry[];
  exactEntry: BrowseEntry | null;
  /** True while the folder the path names is loading and nothing of it is known yet. */
  loading: boolean;
}

/** What the path field means as a folder browser: the directory, its filter, and what the server listed for it. */
export function describeBrowse(input: {
  query: string;
  platform: string;
  cwd: string | null;
  listing: BrowseListing | null;
  pending: boolean;
  /** The clone's own folder, kept at the end of the destination while browsing. */
  pinnedDirectoryName?: string;
  enabled?: boolean;
}): BrowseView {
  const path = getFilesystemBrowsePath(input.query, input.platform, input.enabled ?? true);
  const relativeNeedsProject = isExplicitRelativeProjectPath(input.query.trim()) && input.cwd === null;
  const result = path.isBrowsing && input.listing && input.listing.partialPath === path.directoryPath && input.listing.cwd === input.cwd ? input.listing : null;
  const entries = result?.entries ?? [];
  const filtered = input.pinnedDirectoryName
    ? filterPinnedBrowseEntries({ entries, filterQuery: path.filterQuery, pinnedDirectoryName: input.pinnedDirectoryName, caseSensitive: !isWindowsPlatform(input.platform) })
    : filterBrowseEntries(entries, path.filterQuery);
  return {
    ...path,
    relativeNeedsProject,
    result,
    visibleEntries: filtered.visibleEntries,
    exactEntry: filtered.exactEntry,
    loading: path.isBrowsing && path.directoryPath.length > 0 && !relativeNeedsProject && result === null && input.pending,
  };
}

/** The path a submit acts on: the listed folder for a trailing separator, the exact entry, else what was typed. */
export function resolvedBrowsePath(query: string, view: BrowseView): string {
  return hasTrailingPathSeparator(query) ? (view.result?.parentPath ?? query.trim()) : (view.exactEntry?.fullPath ?? query.trim());
}

/** willCreateProjectPath: Enter would create a folder that does not exist yet. */
export function willCreatePath(query: string, view: BrowseView, hasHighlight: boolean, canSubmit: boolean): boolean {
  return canSubmit && !view.loading && query.trim().length > 0 && !hasHighlight &&
    (hasTrailingPathSeparator(query) ? view.result === null : view.exactEntry === null);
}

export function sourceItems(input: { readiness: ReadinessOf; newProjectsRoot: string | null; query: string }): PaletteGroup[] {
  const items = buildSourceRows({ readiness: input.readiness, newProjectsRoot: input.newProjectsRoot }).map((row): PaletteItem => ({
    value: row.value,
    group: "sources",
    title: row.title,
    description: row.description,
    icon: row.icon,
    searchTerms: row.searchTerms,
    ...(row.setupRequired ? { disabled: true, setupRequired: row.setupRequired } : {}),
    action: row.setupRequired ? { kind: "setup-required" } : { kind: "add-source", source: row.source },
  }));
  return [{ value: "sources", label: "Sources", items: filterItems(items, input.query) }].filter((group) => group.items.length > 0);
}

export function browseGroups(view: BrowseView, label: string): PaletteGroup[] {
  if (view.relativeNeedsProject) return [];
  const items: PaletteItem[] = [];
  if (view.canBrowseUp) {
    items.push({ value: "browse:up", group: "directories", title: "..", icon: "corner-left-up", searchTerms: [".."], action: { kind: "browse-up" } });
  }
  for (const entry of view.visibleEntries) {
    items.push({
      value: `browse:${entry.fullPath}`, group: "directories", title: entry.name, icon: "folder", searchTerms: [entry.fullPath, entry.name],
      action: { kind: "browse-into", name: entry.name },
    });
  }
  return [{ value: "directories", label, items }];
}

export interface NewProjectView {
  name: string;
  pathPreview: string | null;
  targets: readonly PublishTarget[];
  target: PublishTarget | null;
  publishes: boolean;
  creating: boolean;
  repositoryName: string | null;
}

/** The Options group (publish to a host) and the "Add existing project" row of the New project step. */
export function newProjectGroups(view: NewProjectView): PaletteGroup[] {
  const groups: PaletteGroup[] = [];
  if (view.target !== null && view.pathPreview !== null) {
    const label = view.target.host.label;
    groups.push({
      value: "new-project-options",
      label: "Options",
      items: [{
        value: "new-project:publish",
        group: "new-project-options",
        title: view.targets.length > 1 ? "Create private repository" : `Create private repository on ${label}`,
        description: view.name.length > 0 ? (view.repositoryName ?? "") : (view.target.owner ?? `Your ${label} account`),
        icon: view.target.host.icon,
        searchTerms: [],
        ...(view.creating ? { disabled: true } : {}),
        toggle: {
          checked: view.publishes,
          host: view.targets.length > 1 ? label : undefined,
          ...(view.targets.length > 1 ? { hosts: view.targets.map((target) => ({ kind: target.host.kind, label: target.host.label, icon: target.host.icon })), hostKind: view.target.host.kind } : {}),
        },
        action: { kind: "toggle-publish" },
      }],
    });
  }
  groups.push({
    value: "new-project-existing",
    label: "",
    items: [{
      value: "new-project:existing", group: "new-project-existing", title: "Add existing project", description: "Open a folder or clone a repository",
      icon: "folder-plus", submenu: true, searchTerms: [], action: { kind: "existing-project" },
    }],
  });
  return groups;
}


export interface AddProjectEnvironmentOption {
  /** The saved environment's id; null for the live connection. */
  id: string | null;
  label: string;
  connected: boolean;
  isPrimary: boolean;
  /** "Connecting", "Connection failed" ... for one that is not ready. */
  status: string;
}

/** The Environments group of Add project when several environments can take a project (buildEnvironmentItem). */
export function environmentGroups(options: readonly AddProjectEnvironmentOption[], query: string): PaletteGroup[] {
  const items = options.map((option): PaletteItem => ({
    value: `action:add-project:environment:${option.id ?? "primary"}`,
    group: "environments",
    title: option.label,
    description: option.connected ? (option.isPrimary ? "This device" : option.id ?? "") : option.status,
    icon: option.isPrimary ? "monitor" : "server",
    searchTerms: [option.label, option.id ?? "", option.isPrimary ? "this device" : ""],
    ...(option.connected ? {} : { disabled: true }),
    action: { kind: "add-environment", id: option.id },
  }));
  return [{ value: "environments", label: "Environments", items: filterItems(items, query) }].filter((group) => group.items.length > 0);
}
