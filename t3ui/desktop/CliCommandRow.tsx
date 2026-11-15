// CliCommandSettingsRow.tsx: Settings > About's "t3 command" row (after Version), hidden unless the command is
// supported here; Install / Remove and, when the folder is not on PATH, Add to PATH; a failure is an error toast.
import { effect, signal, untracked, View } from "nsh";
import { SettingsButton, SettingsRow } from "../components/SettingsLayout";
import { showToast } from "../components/toast/toastState";
import { TargetRow } from "../pages/settings/TargetRow";
import { CLI_FAILURE_TITLES, cliCommandDescription, cliEnvironmentFromProcess, createCliCommand, type CliCommandState } from "./cliCommand";

const environment = cliEnvironmentFromProcess();
const command = environment ? createCliCommand(environment) : null;
const cliState = signal<CliCommandState | undefined>(undefined);
const pending = signal(false);
let loading = false;

export function refreshCliCommandState() {
  if (!command || loading) return;
  loading = true;
  void command.state().then((next) => cliState.set(next)).finally(() => { loading = false; });
}

function run(action: keyof typeof CLI_FAILURE_TITLES) {
  if (!command || pending()) return;
  pending.set(true);
  void command[action]()
    .then((next) => cliState.set(next))
    .catch((error: unknown) => {
      showToast({ type: "error", title: CLI_FAILURE_TITLES[action], description: error instanceof Error ? error.message : "Something went wrong." });
      refreshCliCommandState();
    })
    .finally(() => pending.set(false));
}

export function CliCommandSettingsRow(props: { path: string }) {
  // Revalidates each time the row mounts (the reference's revalidateOnMount).
  effect(() => { untracked(() => refreshCliCommandState()); });
  const state = () => cliState();
  return (
    <>
      {state()?.supported ? (
        <TargetRow path={props.path} id="cli-command" title="t3 command">
          <SettingsRow
            title="t3 command"
            description={cliCommandDescription(state()!)}
            control={
              <View class="flex-row gap-2">
                {state()!.pathSetup && !state()!.pathSetup!.added ? (
                  <SettingsButton label="Add to PATH" disabled={pending()} onPress={() => run("addToPath")} />
                ) : null}
                <SettingsButton
                  label={state()!.installedPath !== null ? "Remove" : "Install"}
                  disabled={pending() || (state()!.installedPath === null && Boolean(state()!.shadowedBy))}
                  onPress={() => run(state()!.installedPath !== null ? "uninstall" : "install")}
                />
              </View>
            }
          />
        </TargetRow>
      ) : null}
    </>
  );
}
