import { mount, signal, Text, View } from "nsh";
import { SettingsPanel } from "./Panel";
import { configureSettingsSync } from "./settingsSync";
import { replaceServerSettings } from "./settingsState";

const calls = signal<string[]>([]);
const none = { _tag: "None" };
const some = (value: string) => ({ _tag: "Some", value });
const settings: Record<string, unknown> = { defaultAutoPull: false, removeAgentCreditsOnMerge: false, pullRequestMergeMethod: null, projectSettingsOverrides: {}, sourceControlHosts: {} };
let approve: (() => void) | null = null;

configureSettingsSync({
  connected: () => true,
  request: (method, payload) => {
    calls.update((items) => [...items, `${method} ${JSON.stringify(payload)}`]);
    switch (method) {
      case "server.discoverSourceControl":
        return Promise.resolve({
          versionControlSystems: [{ kind: "git", implemented: true, label: "Git", status: "available", version: some("2.45.0"), installHint: "Install Git.", detail: none, executable: "git" }],
          sourceControlProviders: [
            { kind: "github", label: "GitHub", status: "available", version: some("2.60.1"), installHint: "Install gh.", detail: none, executable: "gh", appSignIn: true, auth: { status: "authenticated", account: some("octo"), host: some("github.com"), detail: none } },
            { kind: "bitbucket", label: "Bitbucket", status: "available", version: none, installHint: "Install bb.", detail: none, auth: { status: "unauthenticated", account: none, host: none, detail: none } },
          ],
        });
      case "sourceControl.signInStart":
        return Promise.resolve({ userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresAt: Date.now() + 600_000 });
      case "sourceControl.signInWait":
        return new Promise((resolve) => { approve = () => { settings.sourceControlHosts = { github: { signIns: { "github.com": "redacted" } } }; replaceServerSettings({ ...settings }); resolve({ account: "octo" }); }; });
      case "sourceControl.signInCancel":
        return Promise.resolve({});
      case "server.updateSettings": {
        const patch = (payload as { patch: Record<string, unknown> }).patch;
        const hosts = { ...(settings.sourceControlHosts as Record<string, Record<string, unknown>>) };
        for (const [kind, value] of Object.entries((patch.sourceControlHosts ?? {}) as Record<string, Record<string, unknown>>)) hosts[kind] = { ...(hosts[kind] ?? {}), ...value };
        Object.assign(settings, patch, { sourceControlHosts: hosts });
        return Promise.resolve({ ...settings });
      }
      default:
        return Promise.reject(new Error(`unexpected ${method}`));
    }
  },
});
replaceServerSettings(settings);

mount(() => (
  <View class="flex-1">
    <View accessibilityLabel="Approve sign-in" onPress={() => approve?.()}><Text>Approve sign-in</Text></View>
    <Each of={calls()} key={(call, index) => `${index}${call}`}>{(call) => <Text>{`call ${call()}`}</Text>}</Each>
    <SettingsPanel path="/settings/source-control" />
  </View>
));
