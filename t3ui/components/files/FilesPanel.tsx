// The Files surface (FileBrowserPanel.tsx): the project folder as a tree whose
// folders load on demand through `projects.listEntries`. Pressing a file opens it
// as its own tab (the web's file surface).
import { computed, effect, List, Overlay, signal, Text, untracked, View } from "nsh";
import type { ViewRef } from "nsh";
import { Input } from "nsh/base";
import { requestBackend } from "../../store";
import { fileAccessBlockedText, filesystemReadAccess } from "./fileAccess";
import { FileEntryIcon } from "./FileEntryIcon";
import { HIcon } from "../header/HeaderIcons";
import { showFileMenu } from "./fileActionsRuntime";
import { useWorkspaceMutationRefresh } from "../coordinators/liveRefresh";
import { workspaceMutationId } from "../../store";
import { createStableRows } from "../stableRows";
import { beginMentionDrag, draggedMentions, endMentionDrag, mentionDragInProgress, moveMentionDrag } from "./fileTreeDragMention";
import { dropRemovedTreePaths, expandableDirectories, flattenTree, removedTreePaths, readDirectoryListing, readSearchEntries, searchRows, type DirectoryListing, type FileEntry, type TreeRow } from "./filesLogic";

/** state/queries.ts: PROJECT_PATH_SEARCH_DEBOUNCE_MS, and the limit FileBrowserPanel passes. */
const SEARCH_DEBOUNCE_MS = 120;
const SEARCH_LIMIT = 200;

export interface FilesPanelProps {
  cwd: string;
  projectName?: string | null;
  selectedPath?: () => string | null;
  onOpenFile: (relativePath: string) => void;
  request?: (method: string, payload: unknown) => Promise<unknown>;
}

export function FilesPanel(props: FilesPanelProps) {
  const rpc = props.request ?? requestBackend;
  // useDirectoryEntries / projectFilesQueryState: without filesystem:read the tree shows the access error instead.
  const accessBlocked = () => (props.request ? null : fileAccessBlockedText(filesystemReadAccess()));
  const listings = signal<Record<string, DirectoryListing>>({});
  const expanded = signal<ReadonlySet<string>>(new Set());
  const loading = signal<ReadonlySet<string>>(new Set());
  const rootState = signal<"loading" | "ready" | "error">("loading");
  const error = signal("");
  const query = signal("");
  const searched = signal<{ query: string; entries: FileEntry[]; truncated: boolean } | null>(null);
  const searchError = signal("");
  const menuFailure = signal("");
  // createFileTreeDragMentionController: where the pointer went down on a row, the start of a mention drag.
  let pressStart: { path: string; at: { x: number; y: number } } | null = null;
  let pointer: { path: string; at: { x: number; y: number } } | null = null;
  const searching = () => query().trim() !== "" && searched()?.query !== query().trim();
  let generation = 0;

  // FileBrowserPanel's useProjectPathSearch: the query goes to `projects.searchEntries` after a short pause.
  effect(() => {
    const text = query().trim().slice(0, 256);
    const folder = props.cwd;
    searchError.set("");
    if (!text) { searched.set(null); return; }
    let live = true;
    const timer = setTimeout(() => {
      void rpc("projects.searchEntries", { cwd: folder, query: text, limit: SEARCH_LIMIT }).then((value) => {
        if (!live) return;
        const found = readSearchEntries(value);
        searched.set({ query: text, ...found });
      }).catch((cause: unknown) => {
        if (!live) return;
        searchError.set(cause instanceof Error ? cause.message : "Workspace query failed.");
        searched.set({ query: text, entries: [], truncated: false });
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); };
  });


  async function load(directory: string, request: number) {
    loading.update((current) => new Set(current).add(directory));
    try {
      const value = readDirectoryListing(await rpc("projects.listEntries", { cwd: props.cwd, directoryPath: directory }));
      if (request !== generation) return;
      // fileTreePathReconciliation: what the re-read folder no longer has (a rename or delete) leaves the tree with
      // everything under it, so a renamed folder's old path is not kept open or listed.
      const before = listings()[directory];
      if (before) {
        const removed = removedTreePaths(before.entries, value.entries);
        if (removed.length > 0) {
          const pruned = dropRemovedTreePaths(listings(), expanded(), removed);
          listings.set(pruned.listings);
          expanded.set(pruned.expanded);
        }
      }
      listings.update((current) => ({ ...current, [directory]: value }));
      if (directory === "") { error.set(""); rootState.set("ready"); }
    } catch (cause) {
      if (request !== generation) return;
      if (directory === "") {
        error.set(cause instanceof Error ? cause.message : "Unable to load folder.");
        if (rootState() !== "ready") rootState.set("error");
      } else {
        // A folder that failed to load collapses, so pressing it again retries.
        expanded.update((current) => { const next = new Set(current); next.delete(directory); return next; });
      }
    } finally {
      if (request === generation) loading.update((current) => { const next = new Set(current); next.delete(directory); return next; });
    }
  }

  // loadFileAncestors: the selected file's folders are read (each once) and opened, so the tree reveals it.
  effect(() => {
    const selected = props.selectedPath?.();
    if (!selected || rootState() !== "ready") return;
    untracked(() => {
      const segments = selected.split("/");
      const ancestors = segments.slice(1).map((_segment, index) => segments.slice(0, index + 1).join("/"));
      if (ancestors.length === 0) return;
      const request = generation;
      for (const directory of ancestors) if (!listings()[directory] && !loading().has(directory)) void load(directory, request);
      expanded.update((current) => (ancestors.every((directory) => current.has(directory)) ? current : new Set([...current, ...ancestors])));
    });
  });

  // FileBrowserPanel.tsx:382 useWorkspaceMutationRefresh (minimal hook, shell-stores fix): the open folders re-read in place (no blank) after agent edits.
  useWorkspaceMutationRefresh({ mutationId: () => workspaceMutationId(), refresh: () => { if (rootState() !== "ready") return; const request = ++generation; for (const directory of ["", ...expanded()]) void load(directory, request); }, resourceKey: () => `files:${props.cwd}` });
  function refresh() {
    const request = ++generation;
    const open = ["", ...expanded()];
    const alreadyVisible = rootState() === "ready";
    if (!alreadyVisible) listings.set({});
    loading.set(new Set());
    if (!alreadyVisible) rootState.set("loading");
    error.set("");
    for (const directory of open) void load(directory, request);
  }

  effect(() => {
    const folder = props.cwd;
    void folder;
    const request = ++generation;
    listings.set({});
    expanded.set(new Set());
    loading.set(new Set());
    rootState.set("loading");
    error.set("");
    void load("", request);
    return () => { generation++; };
  });

  function toggle(row: TreeRow) {
    if (row.kind === "file") { props.onOpenFile(row.path); return; }
    if (expanded().has(row.path)) {
      expanded.update((current) => { const next = new Set(current); next.delete(row.path); return next; });
      return;
    }
    expanded.update((current) => new Set(current).add(row.path));
    if (!listings()[row.path]) void load(row.path, generation);
  }

  const searchOn = () => query().trim() !== "";
  const stableRows = createStableRows<TreeRow>((row) => row.path);
  const rows = computed(() => stableRows(props.cwd, searchOn()
    ? searchRows(query(), searched()?.query === query().trim() ? (searched()?.entries ?? []) : [], listings())
    : flattenTree({ listings: listings(), expanded: expanded(), loading: loading() })));
  const directories = () => expandableDirectories(listings());
  const allExpanded = () => directories().length > 0 && directories().every((path) => expanded().has(path));
  function toggleAll() {
    if (allExpanded()) { expanded.set(new Set()); return; }
    const all = new Set(expanded());
    for (const path of directories()) { all.add(path); if (!listings()[path]) void load(path, generation); }
    expanded.set(all);
  }

  return (
    <View class="min-h-0 w-full min-w-0 flex-1 bg-background" accessibilityLabel={`${props.projectName ?? "Project"} files`} role="tree">
      {/* While a row is dragged, the pointer is followed across the window so the composer can show the drop it claims. */}
      {mentionDragInProgress() ? <Overlay class="inset-0 z-50" accessibilityLabel="Dragging file mention" onMouseMove={(event) => moveMentionDrag(event.pagePosition)} /> : null}
      {/* FileBrowserPanel.tsx inline mode: h-9 with mb-1 under the toolbar. */}
      <View class="mb-1 h-9 shrink-0 flex-row items-center gap-1 px-2">
        <View accessibilityLabel="Refresh files" role="button" onPress={refresh} class="size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"><HIcon name="rotate-cw" size={14} /></View>
        <Input
          accessibilityLabel={`Search ${props.projectName ?? "Project"} files`}
          placeholder="Search files"
          value={query()}
          onChange={(event) => query.set(event.value)}
          onKeyPress={(event) => { if (event.key === "Escape") query.set(""); }}
          class="h-7 min-w-0 flex-1 rounded-lg bg-transparent px-2 text-sm text-foreground"
        />
        {directories().length > 0 && !searchOn() ? (
          <View accessibilityLabel={allExpanded() ? "Collapse all folders" : "Expand all folders"} role="button" onPress={toggleAll} class="size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out">
            <HIcon name={allExpanded() ? "chevron-up" : "chevron-down"} size={14} />
          </View>
        ) : null}
      </View>
      {accessBlocked() ? <Text class="p-4 text-left text-xs text-muted-foreground">{accessBlocked()}</Text> : null}
      {!accessBlocked() && rootState() === "error" ? (
        <View accessibilityLabel="Retry loading files" role="button" onPress={refresh} class="p-4">
          <Text class="text-left text-xs text-destructive">{`${error()} Click to retry.`}</Text>
        </View>
      ) : null}
      {!accessBlocked() && rootState() === "ready" && error() ? <Text class="p-4 text-left text-xs text-destructive" role="alert">{`Could not refresh files: ${error()}`}</Text> : null}
      {rootState() === "loading" ? <Text class="px-3 py-1 text-xs text-muted-foreground">Loading files…</Text> : null}
      {menuFailure() ? <Text class="px-3 py-1 text-xs text-destructive" role="alert">{menuFailure()}</Text> : null}
      {searchError() ? <Text class="p-4 text-left text-xs text-destructive">{`${searchError()} Click to retry.`}</Text> : null}
      {searchOn() && searched()?.truncated && !searching() ? <Text class="px-3 py-1 text-xs text-muted-foreground">More matches available. Refine your search.</Text> : null}
      {searching() ? <Text class="px-3 py-1 text-xs text-muted-foreground">Loading files…</Text> : null}
      {searchOn() && !searching() && !searchError() && rows().length === 0 ? <Text class="px-3 py-4 text-xs text-muted-foreground">No matching files.</Text> : null}
      {!searchOn() && rootState() === "ready" && rows().length === 0 ? <Text class="px-3 py-4 text-xs text-muted-foreground">This folder is empty.</Text> : null}
      {!accessBlocked() && rootState() === "ready" ? (
        <List each={rows()} keyExtractor={(row) => row.path} class="min-h-0 w-full flex-1" contentClass="w-full pb-2" testID="Project files">
          {(row) => { let rowNode: ViewRef | null = null; return (
            <View
              ref={(node: ViewRef) => { rowNode = node; }}
              role="treeitem"
              accessibilityLabel={row().name}
              accessibilityState={{ expanded: row().kind === "directory" ? row().expanded : undefined, selected: props.selectedPath?.() === row().path }}
              onPress={() => toggle(row())}
              onContextMenu={(event) => void showFileMenu({ cwd: props.cwd, relativePath: row().path, kind: row().kind === "directory" ? "folder" : "file" }, event.pagePosition, () => {}, rpc)}
              onPressDown={(event) => { pressStart = { path: row().path, at: event.pagePosition }; }}
              onMouseMove={(event) => { pointer = { path: row().path, at: event.pagePosition }; }}
              onPanStart={() => {
                const selection = props.selectedPath?.();
                const drag = draggedMentions(row().path, selection ? [selection] : []);
                if (!drag) return;
                const path = row().path;
                // The press point, else the pointer last seen over this row, else the row's middle (a touch lands there).
                const known = pressStart?.path === path ? pressStart.at : pointer?.path === path ? pointer.at : null;
                if (known) { beginMentionDrag(drag.text, known); return; }
                void (rowNode as ViewRef | null)?.measure().then((at) => { if (at) beginMentionDrag(drag.text, { x: at.pagePosition.x + at.bounds.size.width / 2, y: at.pagePosition.y + at.bounds.size.height / 2 }); });
              }}
              onPanEnd={(event) => { void endMentionDrag(event.translation, event.cancelled); }}
              style={{ paddingLeft: 8 + row().depth * 12 }}
              class={`h-6 w-full flex-row items-center gap-1 pr-2 ${props.selectedPath?.() === row().path ? "bg-accent" : "hover:bg-accent-50"}`}
            >
              {row().kind === "directory" ? <HIcon name={row().expanded ? "chevron-down" : "chevron-right"} size={12} /> : <View class="size-3" />}
              <FileEntryIcon path={row().path} kind={row().kind} expanded={row().expanded} />
              <Text class={`min-w-0 flex-1 truncate text-xs ${row().ignored ? "text-muted-foreground" : "text-foreground"}`}>{row().name}</Text>
              {row().loading ? <Text class="text-2xs text-muted-foreground">…</Text> : null}
            </View>
          );}}
        </List>
      ) : null}
    </View>
  );
}
