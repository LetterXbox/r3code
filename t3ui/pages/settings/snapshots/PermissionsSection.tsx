// User-facing surface for desktop/permissionsHelper.ts (DESKTOP_PARITY_AUDIT.md H4): until this, its status/open-
// settings/recheck logic had no screen. Mac only; lives in the SnapShots panel since both tracked permissions
// exist for SnapShots. Polls like SnapShotSetupDialog.tsx's own permission checklist (createPermissionPoller),
// so a grant made in System Settings while this page is open is picked up without a manual recheck.
import { effect, signal, Text, View } from "nsh";
import { SettingsSection } from "../../../components/SettingsLayout";
import { createPermissionPoller } from "../../../components/permissions/permissionPoller";
import { isMac } from "../../../desktop/runtime";
import { openPermissionSettings, permissionsStatus, recheckPermission, type PermissionsStatus } from "../../../desktop/permissionsHelper";
import { PillButton } from "../providers/ui";
import { PERMISSION_ROWS, permissionBooleanStatus, permissionGranted, permissionRowStatus, permissionStatusLabel, type PermissionRowId } from "./PermissionsSection.logic";

function SmallButton(props: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <PillButton label={props.label} size="xs" variant="outline" disabled={props.disabled} onPress={props.onPress}>
      <Text class="text-xs font-medium text-foreground">{props.label}</Text>
    </PillButton>
  );
}

export function PermissionsSection() {
  if (!isMac()) return null;

  const status = signal<PermissionsStatus | null>(null);
  const checkError = signal<string | null>(null);
  const rechecking = signal<PermissionRowId | null>(null);

  const poller = createPermissionPoller<"accessibility" | "screenRecording">(async () => {
    const next = await permissionsStatus();
    if (!next) throw new Error("Permissions are not tracked on this platform.");
    status.set(next);
    return permissionBooleanStatus(next);
  }, { accessibility: false, screenRecording: false });
  effect(() => {
    poller.start();
    return () => poller.stop();
  });
  effect(() => { checkError.set(poller.snapshot().error); });

  const recheck = async (id: PermissionRowId) => {
    if (rechecking()) return;
    rechecking.set(id);
    try {
      await recheckPermission(id);
      await poller.refresh();
    } catch (error) {
      checkError.set(error instanceof Error && error.message ? error.message : "Couldn't check this permission.");
    } finally {
      rechecking.set(null);
    }
  };

  return (
    <SettingsSection title="Permissions">
      {checkError() ? <Text class="px-4 py-2 text-xs text-destructive">{checkError()}</Text> : null}
      <Each of={PERMISSION_ROWS} key={(row: any) => row.id}>{(row: any) => {
        const state = () => permissionRowStatus(status(), row());
        const granted = () => permissionGranted(state());
        return (
          <View class="flex-row items-center gap-8 px-4 py-3" testID={`Settings row permission-${row().id} (${granted() ? "granted" : "not granted"})`}>
            <View class="min-w-0 flex-1 gap-1">
              <Text class="text-sm font-medium text-foreground">{row().title}</Text>
              <Text class="max-w-[672px] text-xs leading-normal text-muted-foreground">{row().description}</Text>
              <Text class="pt-0.5 text-xs text-muted-foreground">{permissionStatusLabel(state())}</Text>
            </View>
            <View class="flex-row items-center gap-2">
              <SmallButton label="Open System Settings" onPress={() => void openPermissionSettings(row().id)} />
              <SmallButton
                label={rechecking() === row().id ? "Checking…" : "Check again"}
                disabled={rechecking() !== null}
                onPress={() => void recheck(row().id)}
              />
            </View>
          </View>
        );
      }}</Each>
    </SettingsSection>
  );
}
