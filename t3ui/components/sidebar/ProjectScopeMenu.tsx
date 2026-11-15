// The header's "Filter threads by project" control (the projectScope Combobox in Sidebar.tsx): a list-filter button, or the project's mark when
// one project is chosen (two overlapped marks for several). Its popup is a combobox: "Search projects..." on top, "All projects" then every
// project (the chosen ones with a check badge on their icon), "No matching projects." for a query nothing matches. A press chooses one project
// and closes; Shift+press or Shift+Enter adds or removes one and stays open. Each project row has a settings gear (on the highlighted row) and
// a pin button, the thread pin shortcut pins the highlighted project, and a right press opens its settings.
import { effect, keymap, signal, Scroll, Text, token, View } from "nsh";
import { Input } from "nsh/base";
import type { PressEvent } from "nsh";
import { allProjects, projectOrganizationSupported, setProjectPinned, settingValue } from "../../store";
import { serverEnvironment } from "../../pages/settings/settingsState";
import { sortSidebarProjects } from "../SidebarUtils";
import { groupSidebarProjects, projectPickerEntries } from "./projectGrouping";
import { activeRules, shortcutLabel } from "../../commands/registry";
import { ComposerIcon } from "../composer/ComposerIcon";
import { moveHighlight } from "../composer/modelPickerLogic";
import { createAnchor, Popup } from "../composer/Popover";
import { Icon } from "../Icons";
import { Glyph } from "./SidebarGlyph";
import { ProjectTile } from "./ProjectTile";
import { filterProjectScopeItems, holdItemOrder, projectScopeIds, projectScopeItemsOf, setProjectScope } from "./projectScope";
import { showSidebarProjectSettings } from "../SidebarProjectSettingsState";
import { ProjectEnvironmentBadge } from "../../environments/EnvironmentBadges";
import { mixColors } from "./mix";

const ITEM_CLASS = "min-h-7 flex-row items-center gap-2 rounded-sm px-2 py-1";

function CheckBadge() {
  return (
    <View class="absolute -right-1 -bottom-1 size-3 items-center justify-center rounded-full bg-primary">
      <Glyph name="check" size={8} tint={token("primary-foreground")} />
    </View>
  );
}

export function ProjectScopeMenu() {
  const open = signal(false);
  const query = signal("");
  const highlight = signal(0);
  // The rows keep the order they had when the menu opened, so pinning one does not move it under the pointer.
  const frozenOrder = signal<string[] | null>(null);
  const anchor = createAnchor();

  const projectById = (id: string) => allProjects().find((project) => project.id === id);
  const grouping = () => ({ environmentId: String(serverEnvironment()?.environmentId ?? ""), globalMode: settingValue("sidebarProjectGroupingMode"), overrides: settingValue("sidebarProjectGroupingOverrides") });
  const entries = () => {
    const projects = allProjects();
    const groups = projectPickerEntries(projects, grouping(), null);
    const sorted = sortSidebarProjects(groupSidebarProjects(projects, grouping()), settingValue("sidebarProjectSortOrder"));
    const byRepresentative = new Map(groups.map((group) => [group.members[0]!.id, group]));
    return sorted.flatMap((project) => { const entry = byRepresentative.get(project.id); return entry ? [entry] : []; });
  };
  const scoped = () => entries().filter((entry) => entry.members.some((project) => projectScopeIds().includes(project.id))).map((entry) => ({ ...entry.target, name: entry.name }));
  const label = () =>
    scoped().length > 0
      ? `Filter threads by project: ${scoped().map((project) => project.name).join(", ")}`
      : "Filter threads by project";
  const scopeItems = () => projectScopeItemsOf(entries().map((entry) => ({ id: entry.target.id, name: entry.name })));
  const items = () => filterProjectScopeItems(holdItemOrder(scopeItems(), frozenOrder()), query());
  const members = (id: string) => entries().find((entry) => entry.target.id === id)?.members.map((project) => project.id) ?? [id];
  const isSelected = (id: string) => members(id).some((member) => projectScopeIds().includes(member));
  const toggleGroup = (id: string) => {
    const ids = members(id);
    const current = projectScopeIds();
    setProjectScope(isSelected(id) ? current.filter((item) => !ids.includes(item)) : [...new Set([...current, ...ids])]);
  };

  const setOpen = (next: boolean) => {
    if (next === open()) return;
    open.set(next);
    query.set("");
    highlight.set(0);
    frozenOrder.set(next ? scopeItems().map((item) => item.value) : null);
  };
  const close = () => setOpen(false);

  const choose = (value: string, additive: boolean) => {
    if (value === "all") { setProjectScope([]); close(); return; }
    if (additive) { toggleGroup(value); return; }
    setProjectScope(members(value));
    close();
  };
  const togglePin = (id: string) => {
    const project = projectById(id);
    if (!project || !projectOrganizationSupported()) return;
    void setProjectPinned(id, !project.pinned).catch(() => {});
  };
  const openSettings = (id: string) => { close(); showSidebarProjectSettings(id); };
  const highlighted = () => items()[highlight()] ?? null;

  effect(() => { const length = items().length; if (highlight() >= length) highlight.set(Math.max(0, length - 1)); });
  effect(() => {
    if (!open()) return;
    const removers = [keymap.bind({
      up: () => highlight.set(moveHighlight(highlight(), -1, items().length)),
      down: () => highlight.set(moveHighlight(highlight(), 1, items().length)),
      "shift+enter": () => { const item = highlighted(); if (item && item.value !== "all") toggleGroup(item.value); },
    }, { when: "always", repeat: true })];
    // The thread pin shortcut pins the highlighted project here.
    const pinKeystrokes = new Set(activeRules().filter((rule) => rule.command === "thread.pin" && rule.keystroke).map((rule) => rule.keystroke as string));
    for (const keystroke of pinKeystrokes) {
      try { removers.push(keymap.bind(keystroke, () => { const item = highlighted(); if (item && item.value !== "all") togglePin(item.value); }, { when: "always" })); } catch { /* a chord the keymap rejects */ }
    }
    return () => { for (const remove of removers) remove(); };
  });

  const stacked = () => scoped().slice(0, 2);
  return (
    <View>
      <View
        ref={anchor.ref}
        accessibilityLabel={label()}
        role="button"
        onPress={() => setOpen(!open())}
        class="size-7 items-center justify-center rounded-lg hover:bg-sidebar-row-hover active:scale-[0.97] transition-transform duration-150 ease-in-out"
      >
        {scoped().length > 1
          ? (
            <View class="flex-row">
              <Each of={stacked()} key={(project) => project.id}>
                {(project, index) => (
                  <View class={index() === 0 ? "" : "-ml-1 rounded-md bg-sidebar"}>
                    <ProjectTile name={project().name} projectId={project().id} />
                  </View>
                )}
              </Each>
            </View>
          )
          : scoped().length === 1
            ? <ProjectTile name={scoped()[0].name} projectId={scoped()[0].id} />
            : <Glyph name="list-filter" size={16} />}
      </View>
      {open() ? (
        <Popup anchor={anchor.anchor} onClose={close} placement="bottom" align="start" class="w-72">
          <View accessibilityLabel="Projects" role="listbox">
            <View class="px-3 pt-2.5">
              <View class="h-8 flex-row items-center gap-1 border-b border-border-70 pb-1.5">
                <ComposerIcon name="search" size={16} />
                <Input
                  autoFocus
                  value={query()}
                  onChange={(event) => { query.set(event.value); highlight.set(0); }}
                  onSubmit={() => { const item = highlighted(); if (item) choose(item.value, false); }}
                  placeholder="Search projects..."
                  accessibilityLabel="Search projects"
                  class="h-[26px] min-w-0 flex-1 bg-transparent text-sm text-foreground"
                />
              </View>
            </View>
            {items().length === 0 ? (
              <View class="p-2 items-center"><Text class="text-sm text-muted-foreground">No matching projects.</Text></View>
            ) : (
              <Scroll class="max-h-[320px]">
                <View class="gap-0.5 p-1">
                  <Each of={items()} key={(item) => item.value}>
                    {(item, index) => {
                      const project = () => (item().value === "all" ? undefined : projectById(item().value));
                      const selected = () => (item().value === "all" ? projectScopeIds().length === 0 : isSelected(item().value));
                      const pinnable = () => project() !== undefined && projectOrganizationSupported();
                      return (
                        <View
                          role="option"
                          accessibilityLabel={item().label}
                          accessibilityState={{ selected: selected() }}
                          class={ITEM_CLASS}
                          style={{ backgroundColor: highlight() === index() ? mixColors(String(token("foreground")), String(token("popover")), 0.09) : "transparent" }}
                          onMouseEnter={() => highlight.set(index())}
                          onPress={(event?: PressEvent) => choose(item().value, event?.modifiers?.shift === true)}
                          onContextMenu={() => { if (project()) openSettings(item().value); }}
                        >
                          <View class="relative">
                            {project() ? <ProjectTile name={project()!.name} projectId={project()!.id} /> : <Icon name="folder" size={16} tint={token("muted-foreground")} />}
                            {selected() ? <CheckBadge /> : null}
                          </View>
                          <Text class="min-w-0 flex-1 truncate text-sm text-popover-foreground">{item().label}</Text>
                          {project() ? <ProjectEnvironmentBadge environmentId={project()!.environmentId} /> : null}
                          {project() ? (
                            <View class="flex-row items-center">
                              <View
                                role="button"
                                accessibilityLabel={`Project settings for ${project()!.name}`}
                                tooltip={`Project settings for ${project()!.name}`}
                                class={`size-6 items-center justify-center rounded-md hover:bg-accent ${highlight() === index() ? "" : "opacity-0"}`}
                                onPress={() => openSettings(item().value)}
                              >
                                <Icon name="settings" size={14} tint={token("muted-foreground")} />
                              </View>
                              {pinnable() ? (
                                <View
                                  role="button"
                                  accessibilityLabel={`${project()!.pinned ? "Unpin" : "Pin"} ${project()!.name}`}
                                  tooltip={pinTitle(project()!.name, project()!.pinned === true)}
                                  class={`size-6 items-center justify-center rounded-md hover:bg-accent ${project()!.pinned || highlight() === index() ? "" : "opacity-0"}`}
                                  onPress={() => togglePin(item().value)}
                                >
                                  <Glyph name={project()!.pinned ? "pin-off" : "pin"} size={14} tint={token("muted-foreground")} />
                                </View>
                              ) : <View class="size-6" />}
                            </View>
                          ) : (
                            // Keeps "All projects" as tall as the project rows.
                            <View class="ml-auto size-6 shrink-0" />
                          )}
                        </View>
                      );
                    }}
                  </Each>
                </View>
              </Scroll>
            )}
          </View>
        </Popup>
      ) : null}
    </View>
  );
}

/** ProjectPinButton's title: "Pin <name>" with the thread pin shortcut. */
function pinTitle(name: string, pinned: boolean): string {
  const action = `${pinned ? "Unpin" : "Pin"} ${name}`;
  const shortcut = shortcutLabel("thread.pin");
  return shortcut ? `${action} (${shortcut})` : action;
}
