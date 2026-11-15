// components/settings/SnapShotSetupDialog.tsx: the Access / Shortcut wizard. The macOS ("direct") branches are ported
// in full; the Linux helper and GNOME extension branches have no backend on this platform and are left out.
// Accessibility is never grantable in this build (desktop/snapShot.ts), so Continue waits on Screen Recording only.
import { keepPressInDialog } from "../../../components/dialogSurface";
import { effect, Image, signal, Text, View } from "nsh";
import { createPermissionPoller } from "../../../components/permissions/permissionPoller";
import { Dialog } from "nsh/base";
import { useOverlayOpen } from "../../../components/rightPanel/nativeOcclusion";
import { Icon } from "../../../components/Icons";
import { isModifierPairShortcut, type DesktopSnapShotSetupAction, type DesktopSnapShotState } from "../../../desktop/snapShotTypes";
import { PillButton, WizardSteps } from "../providers/ui";
import accessibilityIcon from "./mac-accessibility.svg";
import screenRecordingIcon from "./mac-screen-recording.svg";
import {
  captureSetupAccessReady, captureSetupBackend, captureSetupCheckMessage, captureSetupDesktopName, captureSetupInitialStep, captureSetupShortcutReady,
  type CaptureSetupStep,
} from "./SnapShotSetupDialog.logic";

const SETUP_STEPS = [{ id: "access", label: "Access" }, { id: "shortcut", label: "Shortcut" }] as const;

function Button(props: { label: string; onPress: () => void; disabled?: boolean; variant?: "outline" | "ghost" | "primary"; size?: "xs" | "sm" }) {
  const variant = props.variant ?? "primary";
  return (
    <PillButton label={props.label} size={props.size ?? "sm"} variant={variant} disabled={props.disabled} onPress={props.onPress}>
      <Text class={variant === "primary" ? "text-sm font-medium text-primary-foreground" : "text-sm font-medium text-foreground"}>{props.label}</Text>
    </PillButton>
  );
}

/** permissions/PermissionChecklist.tsx. */
function PermissionChecklist(props: { busy: boolean; permissions: { id: string; icon: any; title: string; description: string; granted: boolean; onAllow: () => void }[] }) {
  return (
    <View class="gap-2">
      <Each of={props.permissions} key={(item) => item.id}>{(item) => (
        <View class="flex-row items-center gap-3 rounded-lg border border-border px-3 py-2" testID={`Permission ${item().title} (${item().granted ? "granted" : "not granted"})`}>
          <Image src={item().icon} style={{ width: 32, height: 32 }} />
          <View class="min-w-0 flex-1">
            <Text class="text-sm font-medium text-foreground">{item().title}</Text>
            <Text class="text-xs text-muted-foreground">{item().description}</Text>
          </View>
          {item().granted
            ? <View class="flex-row items-center gap-1"><Icon name="check" size={16} /><Text class="text-xs text-success">Allowed</Text></View>
            : <Button label="Allow" size="xs" variant="outline" disabled={props.busy} onPress={item().onAllow} />}
        </View>
      )}</Each>
    </View>
  );
}

export function SnapShotSetupDialog(props: {
  state: DesktopSnapShotState;
  initialStep: CaptureSetupStep;
  wasEnabled: boolean;
  includeAccessibility: boolean;
  busy: boolean;
  error: string | null;
  shortcutInput: () => any;
  shortcutStatus: string | null | undefined;
  shortcutChanged: boolean;
  canSaveShortcut: boolean;
  onSaveShortcut: () => Promise<boolean>;
  onEnable: () => Promise<boolean>;
  onAction: (action: DesktopSnapShotSetupAction) => Promise<void>;
  onRefresh: () => Promise<DesktopSnapShotState | undefined>;
  onClose: (completed: boolean) => Promise<void>;
  onLeaveStep: () => void;
}) {
  const step = signal<CaptureSetupStep>(captureSetupInitialStep(props.state, props.initialStep));
  const checking = signal(false);
  const checked = signal(false);
  useOverlayOpen(() => true, "snapshot setup dialog");
  const busy = () => props.busy || checking();
  const backend = () => captureSetupBackend(props.state);
  const desktop = () => captureSetupDesktopName(props.state);
  const accessReady = () => captureSetupAccessReady(props.state);
  // usePermissionStatus: poll the permissions while the Access step shows them and nothing is running.
  const poller = createPermissionPoller<"screenRecording" | "accessibility">(async () => {
    const refreshed = await props.onRefresh();
    if (!refreshed?.macPermissions) throw new Error("Permission status unavailable");
    return refreshed.macPermissions;
  }, props.state.macPermissions ?? { screenRecording: false, accessibility: false });
  effect(() => {
    if (!props.state.macPermissions || step() !== "access" || busy()) return;
    poller.start();
    return () => poller.stop();
  });
  const macPermissions = () => (props.state.macPermissions ? poller.snapshot().status : undefined);
  // The reference waits for every listed permission; Accessibility cannot be granted to this build, so it is optional here.
  const macPermissionsReady = () => !macPermissions() || macPermissions()!.screenRecording;
  const shortcutReady = () => captureSetupShortcutReady(props.state, props.shortcutChanged);
  const changeStep = (next: CaptureSetupStep) => {
    props.onLeaveStep();
    checked.set(false);
    step.set(next);
  };
  const accessCopy = () => {
    if (props.state.message && !macPermissions()) return { title: "Let's try that again", description: "Couldn't check snapshots. Try again to continue." };
    if (backend() === "picker") return { title: "Choose a window each time", description: "Your desktop doesn't support automatic capture. You'll choose the window to capture instead." };
    return {
      title: "Allow snapshots",
      description: backend() === "portal" ? "Your desktop may ask for permission when you first capture."
        : macPermissions() ? (macPermissionsReady()
          ? "Test a snapshot of the current window. If macOS asks to bypass its window picker, choose Allow. The test image is discarded."
          : "Allow each permission, then continue.")
          : "Allow access when prompted to start capturing windows.",
    };
  };
  const title = () => (step() === "access" ? accessCopy().title : "Choose your shortcut");
  const description = () => step() === "access" ? accessCopy().description
    : props.state.mode === "portal" ? "Choose your keys, then approve the permission prompt if asked." : "Use both Shift keys, or record a different shortcut.";
  const stepIndex = () => SETUP_STEPS.findIndex(({ id }) => id === step());
  const details = () => [...new Set([props.error, ...(step() === "access" ? [props.state.message] : [])].filter((detail): detail is string => Boolean(detail)))];
  const advancedOpen = signal(false);
  const close = () => { if (!busy()) void props.onClose(false); };

  return (
    <Dialog open animation="fade" onCancel={close} onOpenChange={({ open }: { open: boolean }) => { if (!open) close(); }} closeOnBackdropPress={false} testID="SnapShot setup dialog"
      backdropClass="bg-black/80" style={{ margin: "auto", width: 512, maxWidth: "92%" }}>
      <View class="w-full flex-col overflow-hidden rounded-2xl border border-border bg-background" onPress={keepPressInDialog}>
        <View class="gap-3 px-6 pt-5 pb-4">
          <View class="flex-row items-center justify-between">
            <Text class="text-lg font-semibold text-foreground">{desktop() ? `Set up snapshots for ${desktop()}` : "Set up snapshots"}</Text>
            {!busy() ? <View role="button" accessibilityLabel="Close" onPress={close} class="size-7 items-center justify-center rounded-md hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out"><Icon name="x" size={16} /></View> : null}
          </View>
          <WizardSteps steps={SETUP_STEPS.map((item) => item.label)} current={stepIndex()} isDisabled={(index) => busy() || index > stepIndex()}
            onChange={(index) => { const next = SETUP_STEPS[index]; if (next && next.id !== step()) changeStep(next.id); }} />
        </View>
        <View class="gap-4 px-6 py-5">
          <View class="gap-2">
            <Text class="text-sm font-medium text-foreground">{title()}</Text>
            <Text class="text-sm text-muted-foreground">{description()}</Text>
          </View>
          {step() === "access" ? <>
            {checked() && !busy() && !props.error ? <Text class="text-xs text-muted-foreground">{captureSetupCheckMessage(props.state)}</Text> : null}
            {macPermissions() ? <PermissionChecklist busy={busy()} permissions={[
              { id: "screenRecording", icon: screenRecordingIcon, title: "Screen Recording", description: "Capture the window you're using.", granted: macPermissions()!.screenRecording, onAllow: () => void props.onAction("allow-screen-recording") },
              { id: "accessibility", icon: accessibilityIcon, title: "Accessibility",
                description: props.includeAccessibility ? "Include text and controls from the captured app." : "Optional. Include text and controls from the captured app.",
                granted: macPermissions()!.accessibility, onAllow: () => void props.onAction("allow-accessibility") },
            ]} /> : null}
            {poller.snapshot().error && macPermissions() ? <Text accessibilityLabel={poller.snapshot().error ?? ""} class="text-xs text-muted-foreground">{poller.snapshot().error}</Text> : null}
          </> : (
            <View class="gap-3">
              <View class="flex-row">{props.shortcutInput()}</View>
              {props.shortcutStatus ? <Text class="text-xs text-muted-foreground">{props.shortcutStatus}</Text> : null}
              {!props.shortcutChanged && !props.state.shortcutRegistered && !props.state.shortcutPending && props.state.shortcutCanRetry !== false && !isModifierPairShortcut(props.state.shortcut)
                ? <View class="flex-row"><Button label={props.state.mode === "portal" ? "Shortcut permissions" : "Try again"} variant="ghost" disabled={busy()} onPress={() => void props.onAction("retry-shortcut")} /></View> : null}
            </View>
          )}
          {step() === "shortcut" && !accessReady() ? <Text class="text-sm text-destructive-foreground">Capture needs attention. Go back to check access.</Text> : null}
          {props.error ? <Text class="text-sm text-destructive-foreground">Couldn't finish this step. Try again or check Advanced for help.</Text> : null}
          {details().length > 0 ? <View class="gap-3">
            <View role="button" accessibilityLabel="Advanced" onPress={() => advancedOpen.set(!advancedOpen())} class="flex-row items-center gap-1 self-start">
              <Icon name={advancedOpen() ? "chevron-down" : "chevron-right"} size={12} />
              <Text class="text-xs text-muted-foreground">Advanced</Text>
            </View>
            {advancedOpen() ? <Each of={details()} key={(detail) => detail}>{(detail) => <Text class="text-xs text-muted-foreground">{detail()}</Text>}</Each> : null}
          </View> : null}
        </View>
        <View class="flex-row items-center justify-end gap-2 border-t border-border-50 px-6 py-4">
          {step() !== "access" ? <Button label="Back" variant="ghost" disabled={busy()} onPress={() => changeStep("access")} /> : null}
          <Button label={props.wasEnabled ? "Close" : "Finish later"} variant="ghost" disabled={busy()} onPress={() => void props.onClose(false)} />
          {step() === "access"
            ? <Button
              label={busy() ? "Working…" : macPermissions() ? "Test capture and continue" : backend() === "direct" ? "Allow capture" : !accessReady() ? "Try again" : "Continue"}
              disabled={!macPermissionsReady() || busy()}
              onPress={async () => { if (await props.onEnable()) changeStep("shortcut"); }}
            />
            : <Button
              label={busy() ? "Saving…" : props.shortcutChanged ? "Save and finish" : "Done"}
              disabled={busy() || !accessReady() || (props.shortcutChanged ? !props.canSaveShortcut : !shortcutReady())}
              onPress={async () => { if (!props.shortcutChanged || (await props.onSaveShortcut())) await props.onClose(true); }}
            />}
        </View>
      </View>
    </Dialog>
  );
}
