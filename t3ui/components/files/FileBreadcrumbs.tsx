// The path above an open file (files/FileBreadcrumbs.tsx): the project and each folder as crumbs, a chevron after each
// folder crumb that opens a menu of that folder's contents (pick a file to open it, a folder to go into it, Back to climb out).
import { Text, View } from "nsh";
import { Tooltip } from "nsh/base";
import { requestBackend } from "../../store";
import { HIcon } from "../header/HeaderIcons";
import { breadcrumbMenuRows, fileBreadcrumbs, type BreadcrumbMenuRow } from "./breadcrumbs";
import { popupOverOverlay } from "./filePopup";
import { isHostPath } from "./explorerState";
import { readDirectoryListing, type FileEntry } from "./filesLogic";

type Rpc = (method: string, payload: unknown) => Promise<unknown>;

export interface FileBreadcrumbsProps {
  cwd: string;
  projectName: string;
  /** The open file's path relative to the workspace. */
  relativePath: string;
  onOpenFile: (relativePath: string) => void;
  /** A crumb opens its folder in this tab (the web's onNavigateFolder). */
  onNavigateFolder?: (path: string) => void;
  /** The retained descendant path: crumbs below the current one stay shown, dimmed. */
  trail?: string;
  request?: Rpc;
}

function Tip(props: { text: string }) {
  return <Tooltip class="rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">{props.text}</Text></Tooltip>;
}

export function FileBreadcrumbs(props: FileBreadcrumbsProps) {
  const rpc = props.request ?? requestBackend;
  const crumbs = () => fileBreadcrumbs(props.projectName, props.trail ?? props.relativePath);
  const listings = new Map<string, { entries: FileEntry[]; truncated: boolean } | "failed">();

  // Each opening reads the folder again; a failed re-read keeps the last listing and offers Refresh failed. Retry.
  const refreshFailed = new Set<string>();
  async function listing(directory: string): Promise<{ entries: FileEntry[]; truncated: boolean } | "failed"> {
    const known = listings.get(directory);
    try {
      const value = readDirectoryListing(await rpc("projects.listEntries", { cwd: props.cwd, ...(directory ? { directoryPath: directory } : {}) }));
      listings.set(directory, value);
      refreshFailed.delete(directory);
      return value;
    } catch {
      if (known && known !== "failed") { refreshFailed.add(directory); return known; }
      return "failed";
    }
  }

  /** Opens the menu of `directory`; going into a folder or back reopens it for the next one. */
  async function openMenu(directory: string, root: string, at: { x: number; y: number }) {
    const found = await listing(directory);
    const rows = breadcrumbMenuRows({
      directoryPath: directory, rootPath: root, projectName: props.projectName, currentFilePath: props.relativePath,
      entries: found === "failed" ? null : found.entries, truncated: found !== "failed" && found.truncated, failed: found === "failed", refreshFailed: refreshFailed.has(directory),
    });
    const items = rows.map((row: BreadcrumbMenuRow) => ({
      label: row.label,
      disabled: row.disabled === true,
      ...(row.current ? { checked: true } : {}),
      onSelect: () => {
        if (row.kind === "file") props.onOpenFile(row.path);
        else if (row.kind === "directory" || row.kind === "back") setTimeout(() => void openMenu(row.path, root, at), 0);
        else if (row.kind === "info" && (found === "failed" || row.label === "Refresh failed. Retry")) { if (found === "failed") listings.delete(directory); setTimeout(() => void openMenu(directory, root, at), 0); }
      },
    }));
    await popupOverOverlay(items, at, "file breadcrumb menu");
  }

  return (
    <View class="min-w-0 flex-row items-center" role="navigation" accessibilityLabel="File path">
      <Each of={crumbs()} key={(crumb) => crumb.path || "project"}>
        {(crumb) => {
          const current = () => crumb().path === props.relativePath;
          return (
            <View class="min-w-0 shrink-0 flex-row items-center">
              <View accessibilityState={{ selected: current() }} {...(!current() && props.onNavigateFolder ? { role: "button" as const, accessibilityLabel: `Open ${crumb().label}`, onPress: () => props.onNavigateFolder?.(crumb().path) } : {})} tooltip={<Tip text={crumb().path || props.projectName} />} class={`max-w-40 rounded-sm px-0.5 ${!current() && props.onNavigateFolder ? "hover:bg-accent" : ""}`}>
                <Text class={`truncate text-xs ${current() ? "font-medium text-foreground" : "text-muted-foreground"}`}>{crumb().label}</Text>
              </View>
              {current() ? null : isHostPath(props.relativePath) ? <View class="mx-1 shrink-0"><HIcon name="chevron-right" size={14} /></View> : (
                <View
                  role="button"
                  accessibilityLabel={`Browse ${crumb().label}`}
                  onPress={(event) => void openMenu(crumb().path, crumb().path, { x: event.pagePosition.x, y: event.pagePosition.y })}
                  class="mx-0.5 h-5 w-4 shrink-0 items-center justify-center rounded-sm hover:bg-accent"
                >
                  <HIcon name="chevron-right" size={14} />
                </View>
              )}
            </View>
          );
        }}
      </Each>
    </View>
  );
}
