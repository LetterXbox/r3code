// The Code tab's changed-files tree, ported from DiffFileTree.tsx and the resizable FileExplorerPane the Code tab
// mounts it in ("Resize PR Code files", default 40% of the row, 192 minimum): the files grouped by folder in the
// order the diff lists them, a status mark per file, a folders collapse control, and a footer for paging.
import { Overlay, Scroll, signal, Text, View } from "nsh";
import { HIcon } from "../header/HeaderIcons";
import type { Content } from "../composer/Popover";
import { createLiveResize } from "../rightPanel/liveResize";
import { diffTreeRows, directoryIds } from "../diff/diffTree";
import { clampTreeWidth, treeWidthFor } from "../diff/treeWidth";
import { ChevronTurn } from "../motion/Motion";
import { savedTreeWidth, setSavedTreeWidth } from "./pullRequestCodePrefs";
import type { PatchFile } from "./pullRequestDiff.logic";
import { diffAdditionClass, diffDeletionClass } from "../diff/diffColorScheme";

// Only added/deleted/untracked tree marks repoint in blue-orange (the reference's
// trees-status-*-override / trees-git-*-color-override, index.css L2306-2311); modified and
// renamed are not in that override list, so they keep their plain warning/info tone in both
// schemes -- unlike DiffPanel.tsx's per-file "renamed" header badge, which is
// --diff-modified-icon's case (muted in blue-orange), not a tree mark's.
const MARK: Record<PatchFile["status"], { letter: string; tone: () => string }> = {
  added: { letter: "A", tone: () => diffAdditionClass("text-success-foreground") },
  deleted: { letter: "D", tone: () => diffDeletionClass("text-destructive") },
  renamed: { letter: "R", tone: () => "text-info-foreground" },
  modified: { letter: "M", tone: () => "text-warning-foreground" },
};

export function PullRequestFileTree(props: {
  files: () => PatchFile[];
  rowWidth: () => number;
  ariaLabel: string;
  onSelectFile: (path: string) => void;
  footer?: () => Content | null;
}) {
  const collapsed = signal<ReadonlySet<string>>(new Set());
  const selected = signal<string | null>(null);
  const width = () => treeWidthFor(savedTreeWidth(), props.rowWidth());
  const resize = createLiveResize({
    axis: "x",
    direction: -1,
    size: () => width(),
    clamp: (value) => clampTreeWidth(value, props.rowWidth()),
    commit: (value) => setSavedTreeWidth(value),
  });
  const changed = () => props.files().map((file) => ({ path: file.path, previousPath: file.oldPath, additions: file.additions, deletions: file.deletions }));
  const rows = () => diffTreeRows(changed(), collapsed());
  const status = (path: string) => MARK[props.files().find((file) => file.path === path)?.status ?? "modified"];
  const allCollapsed = () => directoryIds(changed()).length > 0 && directoryIds(changed()).every((id) => collapsed().has(id));
  const toggle = (id: string) => collapsed.update((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return (
    <View style={{ width: resize.live() ?? width() }} class="relative shrink-0 border-l border-border" accessibilityLabel={props.ariaLabel}>
      <View
        accessibilityLabel="Resize PR Code files"
        role="button"
        focusable={false}
        class="absolute inset-y-0 left-0 z-10 w-[8px]"
        style={{ cursor: "col-resize" }}
        onMouseMove={resize.follow}
        onPress={() => {}}
        onPanStart={resize.handle.onPanStart}
        onPanEnd={resize.handle.onPanEnd}
      >
        <View class={`absolute inset-y-0 left-0 w-px ${resize.live() !== null ? "bg-primary" : "bg-transparent hover:bg-border"}`} />
        {resize.live() !== null ? <Overlay class="inset-0 z-50" accessibilityLabel="Resizing changed files" style={{ cursor: "col-resize" }} onMouseMove={resize.follow} /> : null}
      </View>
      <View class="h-10 min-h-10 shrink-0 flex-row items-center gap-1 border-b border-border-60 px-2">
        <Text class="px-1 text-xs font-medium text-foreground">Files</Text>
        <View class="flex-1" />
        <Text class="text-xs text-muted-foreground">{String(props.files().length)}</Text>
        {directoryIds(changed()).length > 0 ? (
          <View role="button" accessibilityLabel={allCollapsed() ? "Expand all folders" : "Collapse all folders"} onPress={() => collapsed.set(allCollapsed() ? new Set() : new Set(directoryIds(changed())))} class="size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out">
            <HIcon name={allCollapsed() ? "chevrons-up-down" : "chevrons-down-up"} size={14} />
          </View>
        ) : null}
      </View>
      <Scroll class="min-h-0 flex-1" testID="Pull request files tree">
        <Each of={rows()} key={(row) => row.id}>
          {(row) => row().kind === "directory" ? (
            <View role="treeitem" accessibilityLabel={`Folder ${row().label}`} accessibilityState={{ expanded: row().expanded }} onPress={() => toggle(row().id)} style={{ paddingLeft: 8 + row().depth * 12 }} class="h-6 flex-row items-center gap-1 pr-2 transition-colors duration-150 ease-in-out hover:bg-accent-50">
              <ChevronTurn open={() => row().expanded}><HIcon name="chevron-right" size={12} /></ChevronTurn>
              <Text class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{row().label}</Text>
            </View>
          ) : (
            <View role="treeitem" accessibilityLabel={`Show changes in ${row().id}`} accessibilityState={{ selected: selected() === row().id }} onPress={() => { selected.set(row().id); props.onSelectFile(row().id); }} style={{ paddingLeft: 8 + row().depth * 12 + 16 }} class={`h-6 flex-row items-center gap-1 pr-2 transition-colors duration-150 ease-in-out ${selected() === row().id ? "bg-accent" : "hover:bg-accent-50"}`}>
              <Text class="min-w-0 flex-1 truncate text-xs text-foreground">{row().label}</Text>
              <Text class={`text-2xs ${status(row().id).tone()}`}>{status(row().id).letter}</Text>
            </View>
          )}
        </Each>
      </Scroll>
      {props.footer?.() ?? null}
    </View>
  );
}
