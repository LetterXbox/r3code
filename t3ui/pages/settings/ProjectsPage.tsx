// ProjectsSettings.tsx and ProjectSettingsPanel.tsx: the Projects page follows the settings scope. With a project
// chosen it shows that project (name, icon, pin, archive, new thread defaults, actions, checkouts, removal);
// otherwise it asks for one.
import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { SettingsButton, SettingResetButton, SettingsRow, SettingsSection, SettingsSwitch } from "../../components/SettingsLayout";
import { ProjectTile } from "../../components/sidebar/ProjectTile";
import { parseProjectIcon } from "../../components/sidebar/projectIcon";
import { confirm, showToast } from "../../components/toast";
import { allProjects, isProjectArchived, projectOrganizationSupported, requestBackend } from "../../store";
import type { Project } from "../../store";
import { SettingsIcon } from "./SettingsIcon";
import { SettingsSelect } from "../../components/SettingsLayout";
import { settingValue, updateSetting } from "../../store";
import { checkoutKey, groupingLabel, parseGroupingOverrides, PROJECT_GROUPING_MODE_LABELS, withGroupingOverride, type GroupingMode } from "./groupingRules";
import { scopeEnvironments } from "./scopeState";
import { ScopeNotice } from "./ScopeSentence";
import { ProjectActions } from "./ProjectActions";
import { ProjectFaviconPicker, ProjectIconPicker } from "./ProjectIconPickers";
import { DefaultModelControl, WorkspaceControl, defaultModelDescription, workspaceDescription } from "./NewThreadsControls";
import { InheritanceMark } from "./InheritanceMark";
import { liveGroupingInput, projectGroupMembers, updateProjectGroup } from "../../environments/projectGroupUpdate";
import { clearOverrides, currentScope, selectScope, sourceOf, scopeSearch } from "./scopeState";
import { orchestrationOperateDenied } from "./settingsWriteAccess";
import { projectDelete, projectIconDescription, projectTitleNeedsUpdate, projectUpdate, planProjectRemoval, dangerRowCopy } from "./projectsLogic";

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

async function mutate(project: Project, command: Record<string, unknown>, failureTitle: string): Promise<boolean> {
  try {
    await requestBackend("projects.mutate", command);
    return true;
  } catch (cause) {
    showToast({ type: "error", title: failureTitle, description: message(cause) });
    return false;
  }
}

/** The New threads card of a project (ProjectDefaultsSettings category "project"). */
function ProjectDefaults() {
  const reset = (key: string) => (sourceOf([key]) === "project" ? <SettingResetButton label={key === "defaultModelSelection" ? "default model" : "default workspace"} onPress={() => void clearOverrides([key])} /> : null);
  return (
    <SettingsSection title="New threads">
      <SettingsRow title="Model" description={defaultModelDescription()} inheritance={(rowHovered: () => boolean) => <InheritanceMark title="Model" keys={["defaultModelSelection"]} rowHovered={rowHovered} />} resetAction={<View>{reset("defaultModelSelection")}</View>} control={<DefaultModelControl />} />
      <View class="h-px bg-border-50" />
      <SettingsRow title="Workspace" description={workspaceDescription()} inheritance={(rowHovered: () => boolean) => <InheritanceMark title="Workspace" keys={["defaultThreadEnvMode"]} rowHovered={rowHovered} />} resetAction={<View>{reset("defaultThreadEnvMode")}</View>} control={<WorkspaceControl />} />
    </SettingsSection>
  );
}

/** The grouping rule of this checkout: it follows the global mode or has its own. */
function GroupingSelect(props: { project: () => Project }) {
  const key = () => checkoutKey(scopeEnvironments()[0]?.environmentId ?? "", props.project().path ?? "");
  const overrides = () => parseGroupingOverrides(settingValue("sidebarProjectGroupingOverrides"));
  const selection = (): GroupingMode | "inherit" => overrides()[key()] ?? "inherit";
  const globalMode = () => String(settingValue("sidebarProjectGroupingMode") ?? "repository");
  return (
    <SettingsSelect
      label={`Grouping rule for ${props.project().path ?? ""}`}
      value={selection()}
      options={[
        { value: "inherit", label: "Use global default" },
        ...(Object.keys(PROJECT_GROUPING_MODE_LABELS) as GroupingMode[]).map((mode) => ({ value: mode, label: PROJECT_GROUPING_MODE_LABELS[mode] })),
      ]}
      onChange={(next) => updateSetting("sidebarProjectGroupingOverrides", JSON.stringify(withGroupingOverride(overrides(), key(), next as GroupingMode | "inherit")))}
      triggerLabel={groupingLabel(selection(), globalMode())}
      compactWidth={288}
    />
  );
}

function ProjectDetail(props: { project: () => Project }) {
  const project = props.project;
  const pending = signal(false);
  const iconOpen = signal(false);
  const faviconOpen = signal(false);
  const edited = signal(false);
  const name = signal(project().name);
  let shown = project().name;
  const nameValue = () => { if (!edited() && project().name !== shown) { shown = project().name; name.set(shown); } return name(); };
  const icon = () => parseProjectIcon(project().projectIcon);
  const archived = () => isProjectArchived(project().id);
  const organize = async (fields: Record<string, unknown>, failureTitle: string) => {
    pending.set(true);
    // useProjectGroupUpdate: the change goes to every machine's checkout of this project.
    await updateProjectGroup(projectGroupMembers(project(), allProjects(), liveGroupingInput()), fields, failureTitle);
    pending.set(false);
  };
  const rename = async () => {
    const title = name().trim();
    if (!title) { showToast({ type: "warning", title: "Project title cannot be empty" }); name.set(project().name); edited.set(false); return; }
    const wasEdited = edited();
    edited.set(false);
    if (!projectTitleNeedsUpdate(project().name, title, wasEdited)) return;
    await organize({ title }, "Failed to rename project");
  };
  const remove = async () => {
    const threads = project().threads.length;
    if (!(await confirm(planProjectRemoval({ members: [{ id: project().id, environmentId: scopeEnvironments()[0]?.environmentId ?? "", title: project().name, workspaceRoot: project().path ?? "", environmentLabel: scopeEnvironments()[0]?.label ?? null }], groupMemberCount: 1, hasOtherMembers: false, displayName: project().name, threadCount: threads }).confirmationMessage, { variant: "destructive" }))) return;
    pending.set(true);
    const ok = await mutate(project(), projectDelete(project().id), `Failed to remove "${project().name}"`);
    pending.set(false);
    if (ok) selectScope({ ...(scopeSearch().machine ? { machine: scopeSearch().machine } : {}) });
  };
  return (
    <View class="gap-6">
      <View class="flex-row items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-3">
        <SettingsIcon name="info" size={16} />
        <Text class="min-w-0 flex-1 text-sm text-foreground">Can't find a setting? Keep this project picked above and hop to any other settings page.</Text>
      </View>
      <SettingsSection title="Project" hideTitle>
        {orchestrationOperateDenied() ? <Text class="px-4 py-2 text-sm text-muted-foreground">This connection cannot change this project.</Text> : null}
        <SettingsRow
          title="Name"
          description="The shared name for this project group in the sidebar and thread lists."
          control={
            <Input
              accessibilityLabel="Project name"
              value={nameValue()}
              disabled={pending()}
              onChange={(event: { value: string }) => { edited.set(true); name.set(event.value); }}
              onSubmit={() => void rename()}
              onBlur={() => void rename()}
              class="h-6.5 w-64 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground"
            />
          }
        />
        <View class="h-px bg-border-50" />
        <SettingsRow
          title="Project icon"
          description={projectIconDescription(icon(), project().faviconPath ?? null)}
          resetAction={<View>{icon() !== null || project().faviconPath ? <SettingResetButton label="project icon" onPress={() => void organize({ projectIcon: null, faviconPath: null }, "Failed to update project icon")} /> : null}</View>}
          control={
            <View class="flex-row items-center gap-2">
              <ProjectTile name={project().name} projectId={project().id} size={24} />
              <SettingsButton label="Choose icon" accessibilityLabel="Choose a project icon" disabled={pending()} onPress={() => iconOpen.set(true)} />
              <SettingsButton label="Choose file" accessibilityLabel="Choose a project icon file" disabled={pending()} onPress={() => faviconOpen.set(true)} />
            </View>
          }
        />
        {projectOrganizationSupported() ? (
          <>
            <View class="h-px bg-border-50" />
            <SettingsRow title="Pin" description="Pinned projects come first in project pickers." control={<SettingsSwitch label="Pin project" checked={project().pinned === true} onChange={(checked) => void organize({ pinned: checked }, checked ? "Failed to pin project" : "Failed to unpin project")} />} />
            <View class="h-px bg-border-50" />
            <SettingsRow
              title="Archive"
              description={archived() ? "Hidden from project pickers. Threads and files are kept." : "Hides the project from project pickers. Threads and files are kept."}
              control={<SettingsButton label={archived() ? "Unarchive" : "Archive"} disabled={pending()} onPress={() => void organize({ archived: !archived() }, archived() ? "Failed to unarchive project" : "Failed to archive project")} />}
            />
          </>
        ) : null}
      </SettingsSection>
      {iconOpen() ? <ProjectIconPicker current={icon()} projectName={project().name} onClose={() => iconOpen.set(false)} onSelect={(next) => void organize({ faviconPath: null, projectIcon: next }, "Failed to update project icon")} /> : null}
      {faviconOpen() ? <ProjectFaviconPicker cwd={project().path ?? ""} projectName={project().name} onClose={() => faviconOpen.set(false)} onSelect={(path) => void organize({ faviconPath: path, projectIcon: null }, "Failed to update project icon")} /> : null}
      <ProjectDefaults />
      <ProjectActions project={project} />
      <SettingsSection title="Checkouts">
        <View class="px-4 py-2.5"><Text class="text-xs text-muted-foreground">Grouping rule decides how each checkout joins project groups in the sidebar. Changing it can move a checkout to a different project.</Text></View>
        <View class="h-px bg-border-50" />
        <SettingsRow title={scopeEnvironments()[0]?.label ?? "This machine"} description={project().path ?? ""} control={<GroupingSelect project={project} />} />
      </SettingsSection>
      <SettingsSection title="Danger">
        <SettingsRow
          title={dangerRowCopy(1, false).title}
          description={dangerRowCopy(1, false).description}
          control={<SettingsButton label={dangerRowCopy(1, false).button} tone="destructive" disabled={pending()} onPress={() => void remove()} />}
        />
      </SettingsSection>
    </View>
  );
}

export function ProjectsPage() {
  const projectId = () => { const scope = currentScope(); return scope.kind === "project" ? scope.project.id : null; };
  const selected = () => allProjects().filter((candidate) => candidate.id === projectId());
  const unavailable = () => { const scope = currentScope(); return scope.kind === "unavailable" ? scope.message : null; };
  return (
    <View class="gap-6">
      <Each of={selected()} key={(candidate) => candidate.id}>{(candidate) => <ProjectDetail project={candidate} />}</Each>
      {selected().length === 0 && unavailable() ? (
        <View class="items-start gap-3">
          <Text class="text-sm text-muted-foreground">{unavailable()}</Text>
          {scopeSearch().machine ? <SettingsButton label="Show all environments" onPress={() => selectScope({ ...(scopeSearch().project ? { project: scopeSearch().project } : {}) })} /> : null}
        </View>
      ) : null}
      {selected().length === 0 && !unavailable() && allProjects().length === 0 && scopeSearch().project !== undefined ? <Text class="p-8 text-center text-sm text-muted-foreground">Add a project from the sidebar to configure it here.</Text> : null}
      {selected().length === 0 && !unavailable() && (allProjects().length > 0 || scopeSearch().project === undefined) ? <ScopeNotice target="project" inline>Choose a project to manage its name, icon, checkouts and actions.</ScopeNotice> : null}
    </View>
  );
}
