// sidebar/SidebarProjectFolderHeader.tsx: h-8, gap-2.5, px-2.5, the project tile, the name in
// text-sm font-medium, a status dot and thread count only while closed, a size-3 chevron that
// turns -90deg when closed, and a New thread button that appears on hover. The right-click menu
// is handleProjectFolderContextMenu: New thread, Copy path, Pin/Unpin project, Project settings.
import { Clipboard, colorScheme, computed, signal, Text, token, View } from "nsh";
import { ContextMenu, MenuItem, MenuSeparator } from "nsh/base";
import { MENU_ITEM_ROW_CLASS, MENU_POPUP_CLASS, MENU_SEPARATOR_CLASS } from "./menuStyles";
import { SidebarIcon as Icon } from "./SidebarIcon";
import { SidebarThreadRow } from "./SidebarThreadRow";
import { ProjectTile } from "./sidebar/ProjectTile";
import { Glyph } from "./sidebar/SidebarGlyph";
import { THREAD_LIST_TOOLTIP_DELAY_MS, Tip } from "./sidebar/Tip";
import { mixColors } from "./sidebar/mix";
import { threadActionNotice } from "./sidebar/threadActions";
import { FOLDER_DOT_CLASS, resolveFolderDot } from "./sidebar/threadStatus";
import {
  createThread,
  isCollapsed,
  openThread,
  openThreadById,
  projectOrganizationSupported,
  setSidebarThreadQuery,
  setProjectPinned,
  settingValue,
  sidebarThreadQuery,
  toggleProject,
} from "../store";
import { folderThreads } from "./sidebar/sidebarModel";
import type { Project, Thread } from "../store";
import { createStableRows } from "./stableRows";
import { trackOpenChange, useOverlayOpen } from "./rightPanel/nativeOcclusion";
import { projectRowId, releaseFocusRing, treeRowProps } from "./sidebar/sidebarTree";
import { FocusRing } from "./sidebar/FocusRing";
import { showSidebarProjectSettings } from "./SidebarProjectSettingsState";
import { ChevronTurn, toggleWithLayout } from "./motion/Motion";
import { COLLAPSE_MS } from "./motion/motionTokens";
import { MotionEach } from "./motion/Motion";

const FOLDER_DOT_LABEL = { attention: ", needs you", failed: ", failed", unread: ", done", working: ", working" } as const;

export function SidebarProjectFolder(props: { project: () => Project }) {
  const project = props.project;
  const tree = treeRowProps(projectRowId(project().id), () => toggleProject(project().id));
  const hovered = signal(false);
  const focused = signal(false);
  const menuOpen = signal(false);
  useOverlayOpen(menuOpen, "project menu");
  const pinPending = signal(false);
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  const focusIn = () => {
    clearTimeout(blurTimer);
    focused.set(true);
  };
  const focusOut = () => {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => focused.set(false), 200);
  };
  const stableThreads = createStableRows<Thread>((thread) => thread.id);
  const threads = computed(() => stableThreads(project().id, folderThreads(project())));
  const collapsed = () => isCollapsed(project().id) && sidebarThreadQuery().trim().length === 0;
  // A closed folder still shows the open thread, and hints at the rest.
  const shownThreads = () => collapsed()
    ? threads().filter((thread) => thread.id === openThread()?.id)
    : threads();
  const hiddenThreads = () => threads().filter((thread) => !shownThreads().includes(thread));
  const dot = () => collapsed() ? resolveFolderDot(hiddenThreads()) : null;
  const revealed = () => hovered() || focused() || menuOpen();
  const copyPath = async () => {
    const path = project().path;
    if (!path) return;
    try {
      await Clipboard.writeText(path);
      threadActionNotice.success("Path copied", path);
    } catch (error) {
      threadActionNotice.failure("Failed to copy path", error);
    }
  };
  const togglePin = async () => {
    if (pinPending()) return;
    pinPending.set(true);
    try {
      await setProjectPinned(project().id, !project().pinned);
    } catch {
      // The store reports the error through the connection status.
    } finally {
      pinPending.set(false);
    }
  };
  const itemClass = MENU_ITEM_ROW_CLASS;
  const actions = () => (
    <>
      <MenuItem accessibilityLabel="New thread in project" class={itemClass} onSelect={() => createThread(project().id)}>
        <View class="size-4" />
        <Text class="text-sm text-popover-foreground">New thread</Text>
      </MenuItem>
      <MenuItem accessibilityLabel="Copy project path" disabled={!project().path} class={itemClass} onSelect={() => { void copyPath(); }}>
        <View class="size-4" />
        <Text class="text-sm text-popover-foreground">Copy path</Text>
      </MenuItem>
      {projectOrganizationSupported() ? (
        <MenuItem
          accessibilityLabel={project().pinned ? "Unpin project" : "Pin project"}
          disabled={pinPending()}
          class={itemClass}
          onSelect={() => { void togglePin(); }}
        >
          <Glyph name={project().pinned ? "pin-off" : "pin"} size={16} tint={token("muted-foreground")} />
          <Text class="text-sm text-popover-foreground">{project().pinned ? "Unpin project" : "Pin project"}</Text>
        </MenuItem>
      ) : null}
      <MenuSeparator class={MENU_SEPARATOR_CLASS} />
      <MenuItem accessibilityLabel="Open project settings" class={itemClass} onSelect={() => showSidebarProjectSettings(project().id)}>
        <Icon name="settings" size={16} />
        <Text class="text-sm text-popover-foreground">Project settings</Text>
      </MenuItem>
    </>
  );
  const menuClass = MENU_POPUP_CLASS;

  return (
    <View class="mt-2 first:mt-0">
      <ContextMenu popupClass={menuClass} onOpenChange={trackOpenChange(menuOpen)} trigger={
        <View
          class="h-8 flex-row items-center rounded-lg bg-transparent hover:bg-sidebar-row-hover"
          onMouseEnter={() => hovered.set(true)}
          onMouseLeave={() => hovered.set(false)}
        >
          <View
            onPress={() => { releaseFocusRing(); toggleWithLayout(COLLAPSE_MS, () => toggleProject(project().id)); }}
            role="button"
            ref={tree.ref}
            onFocus={() => { focusIn(); tree.onFocus(); }}
            onBlur={() => { focusOut(); tree.onBlur(); }}
            accessibilityLabel={`${collapsed() ? "Expand" : "Collapse"} ${project().name}`}
            accessibilityState={{ expanded: !collapsed() }}
            class="h-8 min-w-0 flex-1 flex-row items-center gap-2.5 px-2.5"
          >
            <FocusRing id={projectRowId(project().id)} rounded="rounded-lg" />
            <ProjectTile name={project().name} projectId={project().id} />
            <Text
              class="min-w-0 flex-1 truncate text-sm font-medium"
              style={{ color: (colorScheme(), mixColors(token("sidebar-foreground"), token("sidebar"), 0.9)) }}
            >
              {project().name}
            </Text>
            {dot() ? <View accessibilityLabel={`${project().name}${FOLDER_DOT_LABEL[dot()!]}`} class={`size-1.5 rounded-full ${FOLDER_DOT_CLASS[dot()!]}`} /> : null}
            {collapsed() && hiddenThreads().length > 0 && !revealed() ? (
              <Text class="text-xs text-sidebar-muted-foreground">{hiddenThreads().length}</Text>
            ) : null}
            {revealed() ? <View class="h-6 w-6" /> : null}
            {/* The web turns a down chevron -90deg when closed, which points right. */}
            <ChevronTurn open={() => !collapsed()}><Icon name="chevron-right" size={12} /></ChevronTurn>
          </View>
          {revealed() ? (
            // Sits over the count, which hides on hover, and left of the chevron.
            <View class="absolute inset-y-0 right-6 flex-row items-center">
              <View
                accessibilityLabel={`New thread in ${project().name}`}
                role="button"
                tooltip={<Tip delay={THREAD_LIST_TOOLTIP_DELAY_MS} label={`New thread in ${project().name}`} />}
                onFocus={focusIn}
                onBlur={focusOut}
                // Button size icon-xs variant ghost-muted: rounded-(--control-radius), `[:hover]:bg-accent`.
                class="size-6 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
                onPress={() => createThread(project().id)}
              >
                <Icon name="square-pen" size={14} />
              </View>
            </View>
          ) : null}
        </View>
      }>
        {actions()}
      </ContextMenu>
      <View class="gap-px">
        <MotionEach of={() => shownThreads()} key={(thread) => thread.id}>
          {(thread) => (
            <SidebarThreadRow
              thread={thread()}
              variant="folder"
              multiline={settingValue("boringSidebarMultilineRows") === true}
              active={openThread()?.id === thread().id}
              projectName={project().name}
              projectPath={project().path}
              onPress={() => {
                openThreadById(thread().id);
                if (sidebarThreadQuery().trim()) setSidebarThreadQuery("");
              }}
            />
          )}
        </MotionEach>
      </View>
    </View>
  );
}
