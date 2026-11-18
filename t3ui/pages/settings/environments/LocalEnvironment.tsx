// LocalEnvironmentSetting.tsx: the "Local environment" switch of the "This app" section, and the
// alert dialog that confirms turning the computer's own server off or on. The web relaunches the
// desktop shell; this app records the choice, and at its next start does not connect to this computer's server
// ("The local environment is disabled.", store.ts initializeBackend). The launcher still starts that server: it is not the app's.
import { signal, Storage, Text, View } from "nsh";
import { SettingsButton, SettingsRow, SettingsSwitch } from "../../../components/SettingsLayout";
import { SettingsDialog } from "../../../components/SettingsDialog";

const KEY = "localEnvironmentDisabled";
const disabled = signal(false);
const confirmOpen = signal(false);
let read = false;

function ensureRead() {
  if (read) return;
  read = true;
  void Storage.getItem(KEY).then((value) => disabled.set(value === "1")).catch(() => undefined);
}

export function localEnvironmentEnabled(): boolean {
  return !disabled();
}

export function LocalEnvironmentSetting() {
  ensureRead();
  const enabled = () => !disabled();
  const apply = () => {
    const next = enabled();
    disabled.set(next);
    void (next ? Storage.setItem(KEY, "1") : Storage.removeItem(KEY)).catch(() => undefined);
    confirmOpen.set(false);
  };
  return (
    <>
      <SettingsRow
        title="Local environment"
        description={enabled()
          ? "Run agents on this computer. Turn off to use R3 Code only with remote environments."
          : "Turned off. Agents only run in remote environments."}
        control={<SettingsSwitch label="Local environment" checked={enabled()} onChange={() => confirmOpen.set(true)} />}
      />
      <SettingsDialog
        open={confirmOpen()}
        onClose={() => confirmOpen.set(false)}
        title={enabled() ? "Turn off local environment?" : "Turn on local environment?"}
        description={enabled()
          ? "R3 Code will restart without running a server on this computer. Any agents and terminals running here will stop, and other devices will no longer be able to connect to this computer. Your projects, history, and remote environments are unaffected."
          : "R3 Code will restart and start running a server on this computer again."}
        footer={
          <>
            <SettingsButton label="Cancel" onPress={() => confirmOpen.set(false)} />
            <SettingsButton
              label={enabled() ? "Restart and turn off" : "Restart and turn on"}
              tone={enabled() ? "destructive" : "primary"}
              onPress={apply}
            />
          </>
        }
      />
    </>
  );
}
