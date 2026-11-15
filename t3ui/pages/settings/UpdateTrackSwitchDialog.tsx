// UpdateTrackSwitchDialog.tsx: the confirmation that moves this app and every connected machine to another update track.
import { cleanup, signal, Text, View } from "nsh";
import { SettingsDialog } from "../../components/SettingsDialog";
import { SettingsButton } from "../../components/SettingsLayout";
import { requestServer } from "./settingsSync";
import { serverEnvironment } from "./settingsState";
import { channelSwitchLabel, npmReleaseErrorMessage, npmReleaseFailureMessage, npmReleaseLookupBlock, readNpmRelease, switchPlan, type ChannelSwitchRelease, type UpdateChannel, type UpdaterState } from "./updateTrackSwitch";

const NPM_RELEASE_STALE_MS = 60_000;
const NPM_RELEASE_REFRESH_MS = 5 * 60_000;
const npmReleaseCache = new Map<string, { at: number; value: Promise<unknown> }>();
/** One server.getNpmRelease per channel within its 60 s stale time. */
export function readNpmReleaseCached(channel: string, request: (method: string, payload: unknown) => Promise<unknown>, now = Date.now()): Promise<unknown> {
  const hit = npmReleaseCache.get(channel);
  if (hit && now - hit.at < NPM_RELEASE_STALE_MS) return hit.value;
  const value = request("server.getNpmRelease", { spec: channel });
  value.catch(() => { if (npmReleaseCache.get(channel)?.value === value) npmReleaseCache.delete(channel); });
  npmReleaseCache.set(channel, { at: now, value });
  return value;
}

export function UpdateTrackSwitchDialog(props: {
  channel: UpdateChannel;
  appVersion: string;
  /** null in a build without an updater. */
  updater: UpdaterState | null;
  onClose: () => void;
  onConfirm?: (release: ChannelSwitchRelease) => void;
  request?: (method: string, payload: unknown) => Promise<unknown>;
}) {
  const release = signal<ChannelSwitchRelease | null>(null);
  const failure = signal("");
  const label = channelSwitchLabel(props.channel);
  const blocked = npmReleaseLookupBlock(serverEnvironment());
  // state/server.ts npmRelease: staleTime 60 s, refreshed every 5 minutes while the dialog reads it.
  const load = async () => {
    try {
      const found = readNpmRelease(props.channel, await readNpmReleaseCached(props.channel, props.request ?? requestServer));
      if (found) { release.set(found); failure.set(""); }
      else failure.set(`Could not find the latest ${label} release in this environment's npm registry.`);
    } catch (cause) {
      failure.set(npmReleaseFailureMessage(cause));
    }
  };
  if (blocked !== null) failure.set(npmReleaseErrorMessage(blocked));
  else {
    void load();
    const timer = setInterval(() => { void load(); }, NPM_RELEASE_REFRESH_MS);
    cleanup(() => clearInterval(timer));
  }
  const migration = () => { const value = serverEnvironment()?.databaseMigration; return typeof value === "number" ? value : undefined; };
  const plan = () => (release() ? switchPlan({ release: release()!, appVersion: props.appVersion, updater: props.updater, databaseMigration: migration() }) : null);
  return (
    <SettingsDialog
      open
      onClose={props.onClose}
      title={plan()?.title ?? `Switch to ${label}`}
      description={plan() ? `Version ${release()!.version}` : failure() || "Checking releases…"}
      testID="Update track switch"
      footer={
        <>
          <SettingsButton label="Cancel" onPress={props.onClose} />
          {plan() ? <SettingsButton label={plan()!.confirmLabel} tone="primary" disabled={plan()!.disabledReason !== null} onPress={() => { props.onConfirm?.(release()!); props.onClose(); }} /> : null}
        </>
      }
    >
      {plan() ? (
        <View class="gap-2">
          <Each of={plan()!.notes} key={(note) => note}>{(note) => <Text class="text-sm text-muted-foreground">{note()}</Text>}</Each>
          {plan()!.disabledReason ? <Text class="text-sm text-destructive-foreground">{plan()!.disabledReason}</Text> : null}
        </View>
      ) : null}
    </SettingsDialog>
  );
}
