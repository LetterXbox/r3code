import { mount, signal, Text, View } from "nsh";
import { SettingsPanel } from "./Panel";
import { configureSettingsSync } from "./settingsSync";

const connected = signal(false);
const calls = signal<string[]>([]);
const none = { _tag: "None" };
const some = (value: string) => ({ _tag: "Some", value });

configureSettingsSync({
  connected: () => connected(),
  request: (method) => {
    calls.update((items) => [...items, method]);
    switch (method) {
      case "server.discoverSourceControl":
        return Promise.resolve({
          versionControlSystems: [
            { kind: "git", implemented: true, label: "Git", status: "available", version: some("2.45.0"), installHint: "Install Git.", detail: none, executable: "git" },
            { kind: "jj", implemented: false, label: "Jujutsu", status: "missing", version: none, installHint: "Install jj.", detail: none },
          ],
          sourceControlProviders: [
            { kind: "github", label: "GitHub", status: "available", version: some("2.60.1"), installHint: "Install gh.", detail: none, executable: "gh", auth: { status: "authenticated", account: some("octo"), host: some("github.com"), detail: none } },
            { kind: "gitlab", label: "GitLab", status: "missing", version: none, installHint: "Install glab.", detail: none, auth: { status: "unknown", account: none, host: none, detail: none } },
          ],
        });
      case "server.getStorageCleanupReport":
        return Promise.resolve({ trigger: "manual", startedAt: "2020-01-01T00:00:00Z", finishedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), entries: [], counts: { removed: 2, kept: 5, failed: 0 }, omittedCount: 0, bytesFreed: 2_500_000 });
      case "server.runStorageCleanup":
        return Promise.resolve({ trigger: "manual", startedAt: "x", finishedAt: new Date().toISOString(), entries: [], counts: { removed: 7, kept: 1, failed: 0 }, omittedCount: 0, bytesFreed: 9_000_000_000 });
      case "server.getDatabaseStorage":
        return Promise.resolve({ databaseBytes: 3 * 1024 ** 3, reclaimableBytes: 2 * 1024 ** 3, incrementalVacuumEnabled: false, compactCommand: "t3 doctor --compact" });
      default:
        return Promise.reject(new Error(`unexpected ${method}`));
    }
  },
});

mount(() => (
  <View class="flex-1">
    <View accessibilityLabel="Connect fixture" onPress={() => connected.set(true)}><Text>Connect fixture</Text></View>
    <Each of={calls()} key={(call, index) => `${index}${call}`}>{(call) => <Text>{`call ${call()}`}</Text>}</Each>
    <SettingsPanel path="/settings/source-control" />
  </View>
));
