import { Text, View } from "nsh";
import { SettingsRow, SettingsSection } from "../../components/SettingsLayout";
import { SidebarProjectSettings } from "../../components/SidebarProjectSettings";
import { clearSidebarProjectSettings, showSidebarProjectSettings, sidebarProjectSettingsId } from "../../components/SidebarProjectSettingsState";
import { allProjects, backendStatus, createThread, openAddProjectPalette } from "../../store";
import type { BackendStatus, Project } from "../../store";

export function ProjectSettingsView(props: {
  projects: Project[];
  status: BackendStatus;
  selectedId: string | null;
  onBack: () => void;
  onSelect: (id: string) => void;
  onNewThread: (id: string) => void;
  onAdd: () => void;
}) {
  const selectedProjects = () => props.projects.filter((project) => project.id === props.selectedId);
  return <>
  <Each of={selectedProjects()} key={(project) => project.id}>{(project) => <SidebarProjectSettings project={project} onBack={props.onBack} />}</Each>
  {selectedProjects().length === 0 ? <SettingsSection title="Projects">
    <View class="px-4 py-3"><Text class="text-sm text-muted-foreground">Choose a project to manage its name, icon, checkouts and actions.</Text></View>
    {props.status !== "connected" ? <View class="px-4 py-4"><Text class="text-sm text-muted-foreground">Connect an environment to see projects.</Text></View> : null}
    {props.status === "connected" && props.projects.length === 0 ? <View class="px-4 py-4"><Text class="text-sm text-muted-foreground">No projects in this environment.</Text></View> : null}
    <Each of={props.projects} key={(project) => project.id}>{(project) => <SettingsRow title={project().name} description={project().path}>
      <View class="flex-row gap-2"><View accessibilityLabel={`New thread in ${project().name}`} onPress={() => props.onNewThread(project().id)} class="rounded-md border border-border px-3 py-1.5 hover:bg-accent"><Text class="text-xs text-foreground">New thread</Text></View>
      <View accessibilityLabel={`Settings for ${project().name}`} onPress={() => props.onSelect(project().id)} class="rounded-md border border-border px-3 py-1.5 hover:bg-accent"><Text class="text-xs text-foreground">Settings</Text></View></View>
    </SettingsRow>}</Each>
    <View class="items-start px-4 py-3"><View accessibilityLabel="Add project from settings" onPress={props.onAdd} class="rounded-md border border-border px-3 py-1.5 hover:bg-accent"><Text class="text-xs text-foreground">Add project</Text></View></View>
  </SettingsSection> : null}
  </>;
}

export function ProjectSettings() {
  return <ProjectSettingsView projects={allProjects()} status={backendStatus()} selectedId={sidebarProjectSettingsId()} onBack={clearSidebarProjectSettings}
    onSelect={showSidebarProjectSettings} onNewThread={createThread} onAdd={openAddProjectPalette} />;
}

const shortcuts = [
  { title: "Command palette", keys: "⌘K" },
  { title: "Settings", keys: "⌘," },
  { title: "Usage", keys: "⌘U" },
  { title: "Toggle sidebar", keys: "⌘B" },
  { title: "New thread", keys: "⌘⇧N" },
];

export function KeybindingsSettings() {
  return <SettingsSection title="Keyboard shortcuts">
    <Each of={shortcuts} key={(shortcut) => shortcut.title}>{(shortcut) => <SettingsRow title={shortcut().title}><Text class="text-xs text-muted-foreground">{shortcut().keys}</Text></SettingsRow>}</Each>
    <View class="px-4 py-3"><Text class="text-xs text-muted-foreground">Custom keybindings are not available in this client yet.</Text></View>
  </SettingsSection>;
}
