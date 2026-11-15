// The palette's Add project with two saved environments on and a second host ready to take a repository: the environment chooser,
// the publish host dropdown, unarchive on add and the app-access suggestion, every RPC answered here and logged with the environment it went to.
import { keymap, mount, signal, Text, View } from "nsh";
import { CommandPalette } from "./components/CommandPalette";
import { addProjectEnvironmentId, setAddProjectBackend } from "./components/palette/addProject/addProjectState";
import { environmentStatuses, savedEnvironments } from "./pages/settings/environments/savedEnvironments";
import { ShellOverlays } from "./shell/ShellOverlays";
import { openAddProjectPalette, togglePalette } from "./store";

const calls = signal<string[]>([]);
const none = { _tag: "None" };
const some = (value: string) => ({ _tag: "Some", value });
const ready = (kind: string, label: string, account: string) => ({
  kind, label, status: "available", version: some("1.0"), installHint: "", detail: none, auth: { status: "authenticated", account: some(account), host: none, detail: none },
});

savedEnvironments.set([
  { id: "saved:studio", label: "Studio", url: "https://studio.example", enabled: true, addedAt: 1 },
  { id: "saved:laptop", label: "Laptop", url: "https://laptop.example", enabled: true, addedAt: 2 },
]);
environmentStatuses.set({ "saved:studio": { phase: "connected" }, "saved:laptop": { phase: "connected" } });

setAddProjectBackend({
  connected: () => true,
  request: (method, payload) => {
    calls.update((all) => [...all, `${method} env=${addProjectEnvironmentId() ?? "primary"} ${JSON.stringify(payload)}`]);
    switch (method) {
      case "server.getConfig":
        return Promise.resolve({ newProjectsRoot: "/home/u/projects", environment: { platform: { os: "darwin" } }, settings: { addProjectBaseDirectory: "", ghqCloneLayout: false } });
      case "server.discoverSourceControl":
        return Promise.resolve({ versionControlSystems: [], sourceControlProviders: [ready("github", "GitHub", "octo"), ready("gitlab", "GitLab", "octo-lab")] });
      case "filesystem.browse":
        return Promise.resolve({ parentPath: "/Users/me", entries: [{ name: "code", fullPath: "/Users/me/code" }] });
      case "projects.createNew":
        return Promise.resolve({ projectId: "p-new", workspaceRoot: "/home/u/projects/my-app" });
      case "sourceControl.appAccess":
        return Promise.resolve({ status: "not-covered" });
      case "projects.mutate":
      case "projectClone.start":
      case "sourceControl.publishRepository":
        return Promise.resolve({});
      default:
        return Promise.reject(new Error(`unexpected ${method}`));
    }
  },
});

keymap.bind("mod+k", togglePalette);

mount(() => (
  <View class="flex-1">
    <View accessibilityLabel="Open add project" onPress={openAddProjectPalette}><Text>Open add project</Text></View>
    <Each of={calls()} key={(call, index) => `${index}${call}`}>{(call) => <Text>{`call ${call()}`}</Text>}</Each>
    <CommandPalette />
    <ShellOverlays />
  </View>
));
