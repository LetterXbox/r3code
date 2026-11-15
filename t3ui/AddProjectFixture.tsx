// The palette with a faked connection, for the Add project flow: every RPC the flow makes is answered here and logged.
import { keymap, mount, signal, Text, View } from "nsh";
import { CommandPalette } from "./components/CommandPalette";
import { ShellOverlays } from "./shell/ShellOverlays";
import { setAddProjectBackend } from "./components/palette/addProject/addProjectState";
import { applyShellEventForTest, openAddProjectPalette, togglePalette } from "./store";

const calls = signal<string[]>([]);
// One archived project the shell lists: adding its folder again brings it back.
applyShellEventForTest({ kind: "snapshot", snapshot: { threads: [], archivedThreads: [], projects: [{
  id: "project:archived", title: "attic", workspaceRoot: "~/attic", archivedAt: "2026-11-01T00:00:00.000Z", pinnedAt: null, scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
}] } });
const none = { _tag: "None" };
const some = (value: string) => ({ _tag: "Some", value });

setAddProjectBackend({
  connected: () => true,
  request: (method, payload) => {
    calls.update((all) => [...all, `${method} ${JSON.stringify(payload)}`]);
    switch (method) {
      case "server.getConfig":
        return Promise.resolve({ newProjectsRoot: "/home/u/projects", environment: { platform: { os: "darwin" } }, settings: { addProjectBaseDirectory: "", ghqCloneLayout: false } });
      case "server.discoverSourceControl":
        return Promise.resolve({
          versionControlSystems: [],
          sourceControlProviders: [
            { kind: "github", label: "GitHub", status: "available", version: some("2.60.1"), installHint: "Install gh.", detail: none, executable: "gh", auth: { status: "authenticated", account: some("octo"), host: none, detail: none } },
            { kind: "bitbucket", label: "Bitbucket", status: "missing", version: none, installHint: "Install the Bitbucket CLI.", detail: none, auth: { status: "unknown", account: none, host: none, detail: none } },
          ],
        });
      case "filesystem.browse": {
        const partial = (payload as { partialPath: string }).partialPath;
        return Promise.resolve({
          parentPath: partial.replace(/^~/, "/Users/me"),
          entries: [{ name: "code", fullPath: "/Users/me/code" }, { name: "docs", fullPath: "/Users/me/docs" }, { name: ".hidden", fullPath: "/Users/me/.hidden" }],
        });
      }
      case "projects.createNew":
        return Promise.resolve({ projectId: "p-new", workspaceRoot: "/home/u/projects/my-app" });
      case "sourceControl.lookupRepository":
        return Promise.resolve({ provider: "github", nameWithOwner: "octo/repo", url: "https://github.com/octo/repo", sshUrl: "git@github.com:octo/repo.git" });
      case "projects.mutate":
      case "projectClone.start":
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
