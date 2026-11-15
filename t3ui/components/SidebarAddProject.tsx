import { Scroll, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { activeProjectId, allProjects, createProject, requestBackend } from "../store";
import { SidebarIcon as Icon } from "./SidebarIcon";
import { addProjectOpen, closeAddProject } from "./SidebarAddProjectState";
import { folderBrowsePath, parentFolder, parseFolderListing, type FolderListing } from "./SidebarFolderBrowserLogic";
import { dialogBackdropStyle } from "./dialogSurface";
import { MENU_ITEM_ROW_CLASS } from "./menuStyles";

export function SidebarAddProject() {
  const path = signal("");
  const error = signal("");
  const pending = signal(false);
  const browsing = signal(false);
  const browsePending = signal(false);
  const browseError = signal("");
  const listing = signal<FolderListing | null>(null);
  const showHidden = signal(false);
  const folderFilter = signal("");
  let browseGeneration = 0;

  const hideBrowser = () => {
    browseGeneration += 1;
    browsing.set(false);
    browsePending.set(false);
    browseError.set("");
    listing.set(null);
    folderFilter.set("");
  };
  const browse = async (folder: string) => {
    const partialPath = folderBrowsePath(folder);
    const generation = ++browseGeneration;
    browsing.set(true);
    browsePending.set(true);
    browseError.set("");
    listing.set(null);
    folderFilter.set("");
    try {
      if (partialPath.length > 512) throw new Error("The folder path is too long.");
      const cwd = allProjects().find((project) => project.id === activeProjectId())?.path;
      const result = parseFolderListing(await requestBackend(
        "filesystem.browse",
        cwd ? { partialPath, cwd } : { partialPath },
      ));
      if (generation !== browseGeneration) return;
      listing.set(result);
      path.set(result.parentPath);
    } catch (cause) {
      if (generation === browseGeneration) browseError.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === browseGeneration) browsePending.set(false);
    }
  };
  const visibleFolders = () => {
    const query = folderFilter().trim().toLowerCase();
    return (listing()?.entries ?? []).filter((entry) =>
      entry.name.toLowerCase().startsWith(query) &&
      (showHidden() || query.startsWith(".") || !entry.name.startsWith(".")),
    );
  };
  const cancel = () => {
    if (pending()) return;
    hideBrowser();
    showHidden.set(false);
    path.set("");
    error.set("");
    closeAddProject();
  };
  const add = async (value = path()) => {
    const folder = value.trim();
    if (!folder || pending() || browsePending()) return;
    pending.set(true);
    error.set("");
    try {
      await createProject(folder);
      hideBrowser();
      showHidden.set(false);
      path.set("");
      closeAddProject();
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.set(false);
    }
  };

  return <>{addProjectOpen() ? (
    <View class="absolute inset-0 items-center justify-center px-6" style={dialogBackdropStyle()}>
      <View class="w-full max-w-[480px] gap-4 rounded-2xl border border-border bg-card p-5">
        <View class="gap-1">
          <Text class="text-base font-semibold text-foreground">Add project</Text>
          <Text class="text-sm text-muted-foreground">
            Enter the project folder path on the connected environment.
          </Text>
        </View>
        <View class="gap-1.5">
          <Text class="text-xs font-medium text-foreground">Folder path</Text>
          <View class="flex-row items-center gap-2">
            <Input
              autoFocus
              accessibilityLabel="Project folder path"
              disabled={pending()}
              value={path()}
              placeholder="/path/to/project"
              onChange={(event) => {
                path.set(event.value);
                error.set("");
                if (browsing()) hideBrowser();
              }}
              onSubmit={(event) => { void add(event.text); }}
              onKeyPress={(event) => { if (event.key === "Escape") cancel(); }}
              class="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm text-foreground"
            />
            <View
              accessibilityLabel="Browse project folders"
              disabled={pending() || browsePending()}
              onPress={() => { void browse(path()); }}
              class="h-9 items-center justify-center rounded-md border border-border px-3 hover:bg-accent"
            >
              <Text class="text-xs text-foreground">Browse</Text>
            </View>
          </View>
        </View>
        {browsing() ? (
          <View class="gap-2">
            <View class="flex-row items-center gap-2">
              <View
                accessibilityLabel="Go to parent folder"
                disabled={pending() || browsePending() || !listing() || parentFolder(listing()?.parentPath ?? "") === null}
                onPress={() => {
                  const parent = parentFolder(listing()?.parentPath ?? "");
                  if (parent) void browse(parent);
                }}
                class="h-7 items-center justify-center rounded-md border border-border px-2"
              >
                <Text class="text-xs text-foreground">Up</Text>
              </View>
              <Text class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {listing()?.parentPath ?? "Folders on the connected environment"}
              </Text>
              <View
                accessibilityLabel={showHidden() ? "Hide hidden folders" : "Show hidden folders"}
                disabled={pending()}
                onPress={() => showHidden.set(!showHidden())}
                class="h-7 items-center justify-center rounded-md px-2 hover:bg-accent"
              >
                <Text class="text-xs text-muted-foreground">{showHidden() ? "Hide hidden" : "Show hidden"}</Text>
              </View>
              <View
                accessibilityLabel="Close folder browser"
                disabled={pending()}
                onPress={hideBrowser}
                class="size-7 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
              >
                <Icon name="x" size={14} />
              </View>
            </View>
            {listing() ? (
              <Input
                accessibilityLabel="Filter folders"
                disabled={pending()}
                value={folderFilter()}
                placeholder="Filter folders"
                onChange={(event) => folderFilter.set(event.value)}
                onSubmit={() => {
                  const matches = visibleFolders();
                  if (matches.length === 1) void browse(matches[0].fullPath);
                }}
                class="h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
              />
            ) : null}
            <Scroll class="h-[200px] rounded-md border border-border" contentClass="p-1">
              {browsePending() ? <Text class="px-3 py-4 text-xs text-muted-foreground">Loading folders...</Text> : null}
              {!browsePending() && browseError() ? (
                <Text class="px-3 py-4 text-xs text-destructive">{browseError()}</Text>
              ) : null}
              {!browsePending() && !browseError() && listing() && visibleFolders().length === 0 ? (
                <Text class="px-3 py-4 text-xs text-muted-foreground">
                  No folders to display. Some folders may be hidden or unavailable.
                </Text>
              ) : null}
              <Each of={visibleFolders()} key={(entry) => entry.fullPath}>
                {(entry) => (
                  <View
                    accessibilityLabel={`Open folder ${entry().name}`}
                    disabled={pending()}
                    onPress={() => { void browse(entry().fullPath); }}
                    class={MENU_ITEM_ROW_CLASS}
                  >
                    <Icon name="folder" size={15} />
                    <Text class="min-w-0 flex-1 truncate text-sm text-foreground">{entry().name}</Text>
                    <Icon name="chevron-right" size={13} />
                  </View>
                )}
              </Each>
            </Scroll>
          </View>
        ) : null}
        {error() ? <Text class="text-xs text-destructive">{error()}</Text> : null}
        <View class="flex-row justify-end gap-2">
          <View
            accessibilityLabel="Cancel adding project"
            disabled={pending()}
            onPress={cancel}
            class="h-8 items-center justify-center rounded-md border border-border px-3"
          >
            <Text class="text-xs text-foreground">Cancel</Text>
          </View>
          <View
            accessibilityLabel="Confirm add project"
            disabled={pending() || browsePending() || !path().trim()}
            onPress={() => { void add(); }}
            class={`h-8 items-center justify-center rounded-md px-3 ${path().trim() ? "bg-primary" : "bg-sidebar-row-active"}`}
          >
            <Text class={`text-xs font-medium ${path().trim() ? "text-primary-foreground" : "text-muted-foreground"}`}>
              {pending() ? "Adding..." : "Add project"}
            </Text>
          </View>
        </View>
      </View>
    </View>
  ) : null}</>;
}
