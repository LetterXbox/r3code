// SettingsScopeSentence.tsx and SettingsScopeNotice.tsx: "Applying settings for [project] across [environment]"
// over every page that is not device-only, and the page notices that offer a way back to a scope that has the
// setting. The two menus are the web's ScopeMenu: an outline button that opens a radio list, with an "All"
// choice first.
import { effect, Scroll, signal, Text, token, untracked, View } from "nsh";
import { Input, Menu, MenuItem } from "nsh/base";
import { Icon } from "../../components/Icons";
import { ProjectTile } from "../../components/sidebar/ProjectTile";
import { trackOpenChange, useOverlayOpen } from "../../components/rightPanel/nativeOcclusion";
import { SettingsPageContainer } from "../../components/SettingsLayout";
import { SettingsIcon } from "./SettingsIcon";
import { ALL_VALUE, selectEnvironmentAxis, selectProjectAxis } from "./scopeCore";
import { currentScope, scopeEnvironments, scopeProjects, scopeSearch, selectScope } from "./scopeState";

interface ScopeOption { value: string; label: string; secondary?: string; offline?: boolean; icon?: any }

const MENU_CLASS = "w-72 overflow-hidden rounded-lg border border-border bg-popover-84 p-1";
const ITEM_CLASS = "min-h-7 flex-row items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent";

function ScopeMenu(props: { ariaLabel: string; icon?: () => any; label: () => string; value: () => string; options: () => ScopeOption[]; allOption: ScopeOption | null; onChange: (next: string) => void; /** ComboboxSearchInput's label and placeholder ("Search projects"). */ searchLabel: string }) {
  const open = signal(false);
  const query = signal("");
  useOverlayOpen(open, "settings scope menu");
  // ScopeCombobox: the search filters every option, the All option included, by its label and secondary line.
  const choices = () => {
    const all = props.allOption ? [props.allOption, ...props.options()] : props.options();
    const text = query().trim().toLowerCase();
    return text ? all.filter((option) => `${option.label} ${option.secondary ?? ""}`.toLowerCase().includes(text)) : all;
  };
  const track = trackOpenChange(open);
  return (
    <Menu
      popupClass={MENU_CLASS}
      onOpenChange={(event: { open: boolean }) => { track(event); if (!event.open) query.set(""); }}
      trigger={
        <View
          role="button"
          accessibilityLabel={`${props.ariaLabel}: ${props.label()}`}
          class="h-7 min-w-0 max-w-72 flex-row items-center gap-1.5 rounded-lg border border-input bg-background px-[9px] hover:bg-accent dark:bg-input-32 transition-colors duration-150 ease-in-out"
        >
          {props.icon?.() ?? null}
          <Text class="min-w-0 shrink truncate text-sm text-foreground">{props.label()}</Text>
          <View class="-mr-0.5 opacity-70"><Icon name="chevron-down" size={14} tint={token("muted-foreground")} /></View>
        </View>
      }
    >
      <View class="h-8 flex-row items-center border-b border-border px-2">
        <Input value={query()} onChange={(event: { value: string }) => query.set(event.value)} placeholder={props.searchLabel} accessibilityLabel={props.searchLabel} class="h-8 min-w-0 flex-1 bg-transparent text-sm text-foreground" />
      </View>
      {choices().length === 0 ? <Text class="px-2 py-1.5 text-sm text-muted-foreground">No matches found.</Text> : (
        <Scroll class="max-h-[280px]">
          <Each of={choices()} key={(option) => option.value}>
            {(option) => (
              <>
                <MenuItem accessibilityLabel={option().label} class={ITEM_CLASS} onSelect={() => props.onChange(option().value)}>
                  {option().icon ?? null}
                  <View class="min-w-0 flex-1">
                    <Text class="truncate text-sm text-popover-foreground">{option().label}</Text>
                    {option().secondary ? <Text class="truncate text-xs text-muted-foreground">{option().secondary}</Text> : null}
                  </View>
                  {option().offline ? <Text class="text-xs text-muted-foreground">Offline</Text> : null}
                  {props.value() === option().value ? <SettingsIcon name="check" size={14} tint={token("popover-foreground")} /> : null}
                </MenuItem>
                {option().value === ALL_VALUE && props.allOption ? <View class="my-1 h-px bg-border" /> : null}
              </>
            )}
          </Each>
        </Scroll>
      )}
    </Menu>
  );
}

const sameName = (name: string) => scopeProjects().filter((project) => project.name === name).length > 1;

function ProjectScopeSelect() {
  const selected = () => scopeProjects().find((project) => project.id === scopeSearch().project);
  return (
    <ScopeMenu
      ariaLabel="Project scope"
      searchLabel="Search projects"
      icon={() => (selected() ? <ProjectTile name={selected()!.name} projectId={selected()!.id} size={14} /> : null)}
      label={() => selected()?.name ?? (scopeSearch().project ? "Unavailable project" : "All projects")}
      value={() => scopeSearch().project ?? ALL_VALUE}
      onChange={(next) => selectScope(selectProjectAxis(scopeSearch(), next))}
      allOption={{ value: ALL_VALUE, label: "All projects" }}
      options={() => scopeProjects().map((project) => ({
        value: project.id,
        label: project.name,
        secondary: sameName(project.name) ? (project.path ?? "") : "",
        icon: <ProjectTile name={project.name} projectId={project.id} size={14} />,
      }))}
    />
  );
}

function EnvironmentScopeSelect(props: { single?: boolean }) {
  const selected = () => scopeEnvironments().find((environment) => environment.environmentId === scopeSearch().machine);
  return (
    <ScopeMenu
      ariaLabel="Environment scope"
      searchLabel="Search environments"
      icon={() => (selected() ? <Icon name="server" size={14} tint={token("muted-foreground")} /> : null)}
      label={() => selected()?.label ?? (scopeSearch().machine ? "Unavailable environment" : props.single ? "No environments" : "All environments")}
      value={() => scopeSearch().machine ?? ALL_VALUE}
      onChange={(next) => selectScope(selectEnvironmentAxis(scopeSearch(), next))}
      allOption={props.single ? null : { value: ALL_VALUE, label: "All environments", icon: <SettingsIcon name="layers" size={14} tint={token("muted-foreground")} /> }}
      options={() => scopeEnvironments().map((environment) => ({
        value: environment.environmentId,
        label: environment.label,
        offline: !environment.connected,
        icon: <Icon name="server" size={14} tint={token("muted-foreground")} />,
      }))}
    />
  );
}

/** SettingsScopeSentence: the line above a scoped page. */
export function ScopeSentence(props: { single?: boolean } = {}) {
  // SettingsScopeProvider singleEnvironment (providers, secrets): one environment is always selected, the primary first
  // (selectSingleEnvironmentScope), so the sentence reads "on <machine>" and offers no "All environments".
  effect(() => {
    if (!props.single || untracked(scopeSearch).machine) return;
    const primary = scopeEnvironments()[0];
    if (primary) selectScope({ ...untracked(scopeSearch), machine: primary.environmentId });
  });
  return (
    <View class="flex-row flex-wrap items-center gap-x-1.5 gap-y-1 px-4" testID="Settings scope sentence">
      <View class="min-w-0 flex-row items-center gap-1.5">
        <Text class="shrink-0 text-sm text-muted-foreground">Applying settings for</Text>
        <ProjectScopeSelect />
      </View>
      <View class="min-w-0 flex-row items-center gap-1.5">
        <Text class="shrink-0 text-sm text-muted-foreground">{scopeSearch().machine ? "on" : "across"}</Text>
        <EnvironmentScopeSelect single={props.single} />
      </View>
    </View>
  );
}

/** The page's message when the selected target cannot show it (`unavailable`, or an environment that is offline). */
export function scopeBlockMessage(): string | null {
  const scope = currentScope();
  if (scope.kind === "unavailable") return scope.message;
  if (scope.kind === "environment") {
    const environment = scopeEnvironments().find((candidate) => candidate.environmentId === scope.environmentId);
    if (!environment?.connected) return `Reconnect ${scope.label} to change its settings.`;
  }
  return null;
}

interface Choice { label: string; secondary?: string; icon: any; search: { project?: string; machine?: string } }

/** SettingsScopeNotice: a sentence and a list of scopes that do have the setting. */
export function ScopeNotice(props: { target: "environment" | "all" | "project"; children: string; inline?: boolean }) {
  const choices = (): Choice[] => props.target === "project"
    ? scopeProjects().map((project) => ({ label: project.name, secondary: project.path ?? "", icon: <ProjectTile name={project.name} projectId={project.id} size={16} />, search: { project: project.id } }))
    : props.target === "environment"
      ? scopeEnvironments().map((environment) => ({ label: environment.label, icon: <Icon name="server" size={16} tint={token("muted-foreground")} />, search: { machine: environment.environmentId } }))
      : [{ label: "Open all environments", icon: <SettingsIcon name="layers" size={16} tint={token("muted-foreground")} />, search: {} }];
  const body = (
    <View class="gap-3">
      <Text class="px-4 text-sm text-muted-foreground">{props.children}</Text>
      <View class="overflow-hidden rounded-2xl border border-border bg-card">
        <Each of={choices()} key={(choice) => JSON.stringify(choice.search)}>
          {(choice, index) => (
            <View>
              {index() > 0 ? <View class="h-px bg-border-50" /> : null}
              <View accessibilityLabel={choice().label} role="button" onPress={() => selectScope(choice().search)} class="min-h-12 flex-row items-center gap-3 px-4 py-2 hover:bg-accent-50">
                {choice().icon}
                <View class="min-w-0 flex-1">
                  <Text class="truncate text-sm font-medium text-foreground">{choice().label}</Text>
                  {choice().secondary ? <Text class="truncate text-xs text-muted-foreground">{choice().secondary}</Text> : null}
                </View>
                <Icon name="chevron-right" size={16} tint={token("muted-foreground")} />
              </View>
            </View>
          )}
        </Each>
      </View>
    </View>
  );
  return props.inline ? body : <SettingsPageContainer>{body}</SettingsPageContainer>;
}
