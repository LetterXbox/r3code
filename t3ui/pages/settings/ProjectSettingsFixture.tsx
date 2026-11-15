import { mount, signal, Text, View } from "nsh";
import type { Project } from "../../store";
import { ProjectSettingsView } from "./WorkspacePanels";

const projects = signal<Project[]>([
  { id: "one", name: "First project", path: "/first", threads: [] },
  { id: "two", name: "Second project", path: "/second", threads: [] },
]);
const selectedId = signal<string | null>(null);
const action = signal("");

mount(() => <View class="flex-1 gap-3">
  <View accessibilityLabel="Remove second fixture project" onPress={() => projects.update((items) => items.filter((item) => item.id !== "two"))}><Text>Remove fixture project</Text></View>
  <View accessibilityLabel="Update second fixture project" onPress={() => projects.update((items) => items.map((item) => item.id === "two" ? { ...item, name: "Updated project" } : item))}><Text>Update fixture project</Text></View>
  {action() ? <Text>{action()}</Text> : null}
  <ProjectSettingsView projects={projects()} status="connected" selectedId={selectedId()}
    onBack={() => selectedId.set(null)} onSelect={(id) => selectedId.set(id)}
    onNewThread={(id) => action.set(`New thread: ${id}`)} onAdd={() => action.set("Add project")} />
</View>);
