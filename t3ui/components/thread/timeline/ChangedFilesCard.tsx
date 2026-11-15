// ChangedFilesTree.tsx ChangedFilesCard: the files a run changed, from its checkpoint turn item, under the reply.
// Header "N changed files" with +/- totals and "Collapse all folders" / "Expand all folders"; the tree folds
// folders (all closed by default, as `allDirectoriesExpanded` starts false) and lists each file with its counts.
// "Open diff", a file row and "N more files in the full diff" open the run's turn diff (useRightPanelActions onOpenTurnDiff).
import { MiddleTruncate } from "../../MiddleTruncate";
import { colorScheme, computed, signal, Text, View } from "nsh";
import { diffTreeRows, directoryIds, type DiffTreeRow } from "../../diff/diffTree";
import { createStableRows } from "../../stableRows";
import type { ChangedFile } from "../../diff/data";
import { TimelineIcon } from "../markdown/TimelineIcon";
import { HIcon } from "../../header/HeaderIcons";
import { chatWidthClass } from "../layout";
import type { TurnItem } from "./turnItemDetail";
import { diffAdditionClass, diffDeletionClass } from "../../diff/diffColorScheme";
import { Icon } from "../../Icons";
import { openTurnDiff as openTurnDiffSurface } from "../../diff/openDiff";
import { fileChipMenuItems } from "../markdown/MarkdownChips";
import { popupOverOverlay } from "../../files/filePopup";
import { FileEntryIcon } from "../../files/FileEntryIcon";
import { tokenAlpha, tokenOver } from "../../composer/tokenColor";

/** useRightPanelActions onOpenTurnDiff: select the run's turn diff (optionally a file in it) and open the diff surface. */
/** The changed file's menu: the file link menu (editor, file manager, copy path) for the workspace file. */
export function showChangedFileMenu(cwd: string | null | undefined, threadId: string | null, filePath: string, position: { x: number; y: number }) {
  const root = (cwd ?? "").replace(/\/+$/, "");
  const absolute = filePath.startsWith("/") || !root ? filePath : `${root}/${filePath}`;
  const meta = { filePath: absolute, targetPath: absolute, workspaceRelativePath: filePath.startsWith("/") ? null : filePath, basename: filePath.slice(filePath.lastIndexOf("/") + 1) };
  void fileChipMenuItems(meta, threadId).then((items) => popupOverOverlay(items, position, "changed file menu"));
}

export function openTurnDiff(threadId: string | null | undefined, runId: string, filePath?: string) {
  if (!threadId) return;
  openTurnDiffSurface(threadId, runId, filePath);
}

type Rec = Record<string, unknown>;
export type CheckpointSummary = { runId: string | null; files: ChangedFile[]; totals: { count: number; additions: number; deletions: number } };

/** A checkpoint turn item's files and totals (checkpointFileTotals), or null when it carries none. */
export function checkpointSummary(item: TurnItem | undefined): CheckpointSummary | null {
  if (!item || item.type !== "checkpoint") return null;
  const it = item as Rec;
  const files: ChangedFile[] = (Array.isArray(it.files) ? it.files : []).flatMap((value) => {
    const file = value as Rec | null;
    if (!file || typeof file.path !== "string") return [];
    return [{ path: file.path, previousPath: null, additions: typeof file.additions === "number" ? file.additions : 0, deletions: typeof file.deletions === "number" ? file.deletions : 0 } as ChangedFile];
  });
  if (files.length === 0) return null;
  const total = it.filesTotal as Rec | undefined;
  const totals = total && typeof total.count === "number"
    ? { count: total.count, additions: Number(total.additions) || 0, deletions: Number(total.deletions) || 0 }
    : { count: files.length, additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0) };
  return { runId: typeof it.runId === "string" ? it.runId : null, files, totals };
}

/** Whether a run's folders are all open, per thread key and run (threadChangedFilesExpandedById). */
const expandedByRun = signal<Record<string, boolean>>({});

function DiffStat(props: { additions: number; deletions: number; size?: "xs" | "3xs" }) {
  // ChangedFilesTree.tsx: the header's DiffStatLabel is text-xs; each row's (file or directory) is text-3xs.
  const textClass = props.size === "3xs" ? "text-3xs" : "text-xs";
  return (
    <View class="flex-row gap-1">
      <Text class={`${textClass} tabular-nums ${diffAdditionClass("text-success-foreground")}`}>{`+${props.additions.toLocaleString()}`}</Text>
      <Text class={`${textClass} tabular-nums ${diffDeletionClass("text-error-foreground")}`}>{`-${props.deletions.toLocaleString()}`}</Text>
    </View>
  );
}

export function ChangedFilesCard(props: { id: string; summary: () => CheckpointSummary; onOpenTurnDiff?: (runId: string, filePath?: string) => void; /** The file context menu (useFileContextMenuHandler) at the press point. */ onFileContextMenu?: (filePath: string, position: { x: number; y: number }) => void }) {
  const openDiff = (filePath?: string) => { const runId = props.summary().runId; if (runId) props.onOpenTurnDiff?.(runId, filePath); };
  const key = () => props.summary().runId ?? props.id;
  const allExpanded = () => expandedByRun()[key()] ?? false;
  const directoryPaths = computed(() => directoryIds(props.summary().files));
  const expansionKey = () => JSON.stringify([key(), allExpanded(), directoryPaths()]);
  const overrides = signal<{ key: string; open: Record<string, boolean> }>({ key: "", open: {} });
  const opened = () => (overrides().key === expansionKey() ? overrides().open : {});
  const stableRows = createStableRows<DiffTreeRow>((row) => row.id);
  const rows = computed(() => {
    const collapsed = new Set(directoryPaths().filter((id) => !(opened()[id] ?? allExpanded())));
    return stableRows(key(), diffTreeRows(props.summary().files, collapsed, { directoriesFirst: true }));
  });
  const hasDirectories = () => props.summary().files.some((file) => /[/\\]/.test(file.path));
  const toggleDirectory = (id: string) => overrides.update((current) => {
    const currentKey = expansionKey();
    const open = current.key === currentKey ? current.open : {};
    return { key: currentKey, open: { ...open, [id]: !(open[id] ?? allExpanded()) } };
  });
  const totals = () => props.summary().totals;
  const hidden = () => totals().count - props.summary().files.length;
  return (
    <View class={`mx-auto w-full ${chatWidthClass()}`}>
      <View class="mt-4 rounded-lg bg-secondary" style={colorScheme() === "dark" ? { backgroundColor: tokenAlpha("input", 0.2) } : undefined}>
        <View class="flex-row items-center justify-between gap-2 rounded-t-lg bg-secondary px-3 py-2" style={{ position: "sticky", top: 8, zIndex: 10, ...(colorScheme() === "dark" ? { backgroundColor: tokenOver("input", "background", 0.2) } : {}) }}>
          <View class="min-w-0 flex-row flex-wrap items-center gap-x-3 gap-y-1">
            <Text class="text-xs font-medium text-foreground">{`${totals().count.toLocaleString()} changed file${totals().count === 1 ? "" : "s"}`}</Text>
            {totals().additions > 0 || totals().deletions > 0 ? <DiffStat additions={totals().additions} deletions={totals().deletions} /> : null}
          </View>
          <View class="shrink-0 flex-row items-center gap-1">
          {hasDirectories() ? (
            <View
              class="size-6 items-center justify-center rounded-md hover:bg-accent"
              onPress={() => expandedByRun.update((all) => ({ ...all, [key()]: !allExpanded() }))}
              accessibilityLabel={allExpanded() ? "Collapse all folders" : "Expand all folders"}
              tooltip={allExpanded() ? "Collapse all folders" : "Expand all folders"}
              role="button"
            >
              <HIcon name={allExpanded() ? "chevrons-down-up" : "chevrons-up-down"} size={12} />
            </View>
          ) : null}
          <View
            class="h-6 flex-row items-center gap-1 rounded-md px-1.5 hover:bg-accent"
            onPress={() => openDiff(props.summary().files[0]?.path)}
            accessibilityLabel="Open diff"
            tooltip="Open the full diff"
            role="button"
          >
            <Icon name="file-diff" size={12} />
            <Text class="text-xs text-muted-foreground">Open diff</Text>
          </View>
          </View>
        </View>
        <View class="p-2">
          <Each of={rows()} key={(row) => row.id}>
            {(row) => (
              <View
                class="h-7 flex-row items-center gap-2 rounded-md pr-2 hover:bg-accent"
                style={{ paddingLeft: 8 + row().depth * 14 }}
                onPress={row().kind === "directory" ? () => toggleDirectory(row().id) : () => openDiff(row().id)}
                onContextMenu={row().kind === "file" && props.onFileContextMenu ? ((event: { pagePosition: { x: number; y: number } }) => props.onFileContextMenu?.(row().id, event.pagePosition)) as never : undefined}
                accessibilityLabel={row().kind === "directory" ? `${row().expanded ? "Collapse" : "Expand"} ${row().label}` : row().id}
                role="button"
              >
                {row().kind === "directory" ? <>
                  <TimelineIcon name={row().expanded ? "chevron-down" : "chevron-right"} size={14} />
                  <TimelineIcon name="folder" size={14} />
                </> : <>
                  {hasDirectories() || row().depth > 0 ? <View class="size-3.5 shrink-0" /> : null}
                  <FileEntryIcon path={row().id} kind="file" size={14} />
                </>}
                <MiddleTruncate value={row().label} labelled={false} class="flex-1" textClass={row().kind === "directory" ? "font-mono text-2xs text-muted-foreground" : "font-mono text-xs text-foreground"} />
                {row().file && (row().file!.additions > 0 || row().file!.deletions > 0) ? <DiffStat additions={row().file!.additions} deletions={row().file!.deletions} size="3xs" /> : null}
                {row().kind === "directory" && row().stat && (row().stat!.additions > 0 || row().stat!.deletions > 0) ? <DiffStat additions={row().stat!.additions} deletions={row().stat!.deletions} size="3xs" /> : null}
              </View>
            )}
          </Each>
          {hidden() > 0 ? (
            <View class="self-start rounded-md px-3 pt-1 hover:bg-accent" onPress={() => openDiff(props.summary().files[0]?.path)} role="button">
              <Text class="text-xs text-muted-foreground">{`${hidden().toLocaleString()} more file${hidden() === 1 ? "" : "s"} in the full diff`}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}
