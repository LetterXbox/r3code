// components/settings/SnapShotSettings.tsx. This app is the desktop client, so the reference's desktop bridge is always
// present (t3ui/desktop/snapShot.ts serves it natively): the section is never the "Only available in the desktop app."
// group. Rows, copy, order and the setup flow are the reference's; the macOS branches apply (mode "direct").
import { effect, signal, Text, View } from "nsh";
import { SettingsSection, SettingsSelect, SettingsSwitch } from "../../../components/SettingsLayout";
import { activeRules } from "../../../commands/registry";
import { SettingsIcon } from "../SettingsIcon";
import { showToast } from "../../../components/toast/toastState";
import {
  checkSnapShotShortcut, playSnapShotSound, refreshSnapShotState, requestSnapShotPermissions, saveSnapShotSettings, setupSnapShot,
  snapShotSettings, snapShotState, type SnapShotSettingsPatch,
} from "../../../desktop/snapShot";
import { sameSnapShotShortcut, snapShotKeybindingConflict } from "../../../desktop/snapShotShortcut";
import { isModifierPairShortcut, type DesktopSnapShotSetupAction, type DesktopSnapShotShortcutAvailability, type DesktopSnapShotState, type SnapShotShortcut } from "../../../desktop/snapShotTypes";
import { commandLabel } from "../keybindingsLogic";
import { registerSettingsRow, settingsTarget } from "../settingsSearchNav";
import { PillButton } from "../providers/ui";
import { createShortcutRecorder } from "./ShortcutRecorder";
import { SnapShotSetupDialog } from "./SnapShotSetupDialog";
import { captureSetupAccessReady, captureSetupInitialStep, captureSetupShouldDisableOnClose, type CaptureSetupStep } from "./SnapShotSetupDialog.logic";
import {
  snapShotAccessibilityUnavailableMessage, snapShotDescription, snapShotFeedbackUnavailableMessage, snapShotSetupButtonLabel, snapShotSetupComplete,
  snapShotShortcutStatus, snapShotSoundPatch, snapShotStatus, snapShotUnavailableMessage, type SnapShotSoundSelection,
} from "./SnapShotSettings.logic";
import { clearSnapShotSetupResume, readSnapShotSetupResume, saveSnapShotSetupResume } from "./setupResume";

const PATH = "/settings/snap-shot";

type ShortcutCheck =
  | { status: "idle"; availability: null }
  | { status: "checking"; availability: null; shortcut: SnapShotShortcut; savedShortcut: SnapShotShortcut }
  | { status: "checked"; shortcut: SnapShotShortcut; savedShortcut: SnapShotShortcut; availability: DesktopSnapShotShortcutAvailability };

const errorMessage = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/** A settings row that the settings search can scroll to and highlight. */
function Row(props: { id: string; title: string; description?: string | null; status?: string | null | undefined; control: any; dimmed?: boolean }) {
  const isTarget = () => settingsTarget()?.path === PATH && settingsTarget()?.id === props.id;
  return (
    <View ref={(node: any) => registerSettingsRow(PATH, props.id, node)} testID={`Settings row ${props.id} (${isTarget() ? "target" : "idle"})`} class={isTarget() ? "bg-accent-50" : undefined}>
      <View class="flex-row items-center gap-8 px-4 py-3">
        <View class="min-w-0 flex-1 gap-1">
          <Text class="text-sm font-medium text-foreground">{props.title}</Text>
          {props.description ? <Text class="max-w-[672px] text-xs leading-normal text-muted-foreground">{props.description}</Text> : null}
          {props.status ? <Text class="pt-0.5 text-xs text-muted-foreground">{props.status}</Text> : null}
        </View>
        <View class="flex-row items-center gap-2">{props.control}</View>
      </View>
    </View>
  );
}

/** Switch with `disabled`: SettingsSwitch draws none, so a disabled switch takes no presses and dims. */
function Toggle(props: { label: string; checked: boolean; disabled: boolean; onChange: (next: boolean) => void }) {
  return (
    <View style={props.disabled ? { pointerEvents: "none" } : undefined} class={props.disabled ? "opacity-64" : undefined}>
      <SettingsSwitch label={props.label} checked={props.checked} onChange={props.onChange} />
    </View>
  );
}

function SmallButton(props: { label: string; onPress: () => void; disabled?: boolean; variant?: "outline" | "ghost" | "primary" }) {
  return (
    <PillButton label={props.label} size="xs" variant={props.variant ?? "outline"} disabled={props.disabled} onPress={props.onPress}>
      <Text class={props.variant === "primary" ? "text-xs font-medium text-primary-foreground" : "text-xs font-medium text-foreground"}>{props.label}</Text>
    </PillButton>
  );
}

export function SnapShotSettings() {
  const settings = () => snapShotSettings();
  const state = () => snapShotState();
  const refreshError = signal<{ title: string; message: string } | null>(null);
  const setupBusy = signal(false);
  const setupError = signal<{ title: string; message: string } | null>(null);
  // macOS can quit the app from a permission prompt; a saved resume reopens the wizard where it left off.
  const resume = readSnapShotSetupResume();
  const chosenWizard = signal<{ initialStep: CaptureSetupStep; wasEnabled: boolean } | null | undefined>(undefined);
  const wizard = () => {
    const chosen = chosenWizard();
    if (chosen !== undefined) return chosen;
    return state()?.macPermissions && resume ? { initialStep: "access" as const, wasEnabled: resume.wasEnabled } : null;
  };

  const reportSetupError = (title: string, error: unknown) => {
    const report = { title, message: errorMessage(error, "Try again.") };
    setupError.set(report);
    // The wizard shows errors inline; outside it there is nowhere to, so they become a toast.
    if (!wizard()) showToast({ type: "error", title: report.title, description: report.message });
  };
  const refreshState = async (): Promise<DesktopSnapShotState | undefined> => {
    try {
      const next = await refreshSnapShotState();
      refreshError.set(null);
      return next;
    } catch (error) {
      refreshError.set({ title: "Couldn't check capture setup", message: errorMessage(error, "Try again.") });
      reportSetupError("Couldn't check capture setup", error);
      return undefined;
    }
  };
  void refreshState();
  // A setting written elsewhere (or hydration) re-reads the state, as the reference's settings subscription does.
  effect(() => {
    const current = settings();
    void current.snapShotEnabled, current.snapShotIncludeAccessibility, JSON.stringify(current.snapShotShortcut);
    queueMicrotask(() => void refreshState());
  });

  const candidate = signal<SnapShotShortcut>(settings().snapShotShortcut);
  const latestShortcutCheck = signal<ShortcutCheck>({ status: "idle", availability: null });
  let shortcutCheckId = 0;
  let renderedSavedShortcut = settings().snapShotShortcut;
  effect(() => {
    // Hydration can hand back an equal shortcut object; only a different shortcut resets the edit.
    const saved = settings().snapShotShortcut;
    if (sameSnapShotShortcut(renderedSavedShortcut, saved)) return;
    renderedSavedShortcut = saved;
    candidate.set(saved);
    latestShortcutCheck.set({ status: "idle", availability: null });
  });
  const savedShortcut = () => settings().snapShotShortcut;
  const shortcutCheck = (): ShortcutCheck => {
    const latest = latestShortcutCheck();
    return latest.status === "idle" || (sameSnapShotShortcut(latest.shortcut, candidate()) && sameSnapShotShortcut(latest.savedShortcut, savedShortcut()))
      ? latest : { status: "idle", availability: null };
  };
  const unavailableMessage = snapShotUnavailableMessage(true);
  const captureAvailable = () => state() !== null && state()!.mode !== "unavailable";
  const feedbackUnavailable = () => snapShotFeedbackUnavailableMessage(state());
  const managedShortcut = () => state()?.linuxBackend === "niri" || state()?.linuxBackend === "hyprland";
  const shortcutChanged = () => !managedShortcut() && !sameSnapShotShortcut(candidate(), savedShortcut());
  const displayShortcut = () => (shortcutChanged() ? candidate() : (state()?.shortcut ?? savedShortcut()));
  const candidateConflict = () => (shortcutChanged() ? snapShotKeybindingConflict(candidate(), activeRules()) : null);
  const canSaveShortcut = () => shortcutChanged() && candidateConflict() === null && shortcutCheck().availability?.available === true;
  const soundSelection = (): SnapShotSoundSelection => (settings().snapShotPlaySound ? settings().snapShotSound : "off");

  const save = async (patch: SnapShotSettingsPatch): Promise<DesktopSnapShotState | undefined> => {
    setupError.set(null);
    try {
      await saveSnapShotSettings(patch);
      return await refreshState();
    } catch (error) {
      reportSetupError("Couldn't save capture settings", error);
      return undefined;
    }
  };

  const setup = async (action: DesktopSnapShotSetupAction) => {
    if (setupBusy()) return;
    setupBusy.set(true);
    setupError.set(null);
    try {
      if (state()?.macPermissions && wizard() && (action === "allow-screen-recording" || action === "allow-accessibility")) {
        // macOS can quit the app from its permission prompt.
        saveSnapShotSetupResume(wizard()!.wasEnabled);
      }
      await setupSnapShot(action);
      await refreshState();
    } catch (error) {
      reportSetupError(action === "retry-shortcut" ? "Couldn't open shortcut permissions" : "Couldn't complete capture setup", error);
    }
    setupBusy.set(false);
  };

  const saveIncludeAccessibility = async (includeAccessibility: boolean) => {
    try {
      if (includeAccessibility && settings().snapShotEnabled) await requestSnapShotPermissions(true);
      await save({ snapShotIncludeAccessibility: includeAccessibility });
    } catch (error) {
      reportSetupError("Couldn't allow app text capture", error);
    }
  };

  const checkShortcut = async (shortcut: SnapShotShortcut) => {
    const checkId = ++shortcutCheckId;
    candidate.set(shortcut);
    if (snapShotKeybindingConflict(shortcut, activeRules())) return;
    const saved = savedShortcut();
    latestShortcutCheck.set({ status: "checking", availability: null, shortcut, savedShortcut: saved });
    try {
      const availability = await checkSnapShotShortcut(shortcut);
      if (checkId === shortcutCheckId) latestShortcutCheck.set({ status: "checked", availability, shortcut, savedShortcut: saved });
    } catch (error) {
      if (checkId !== shortcutCheckId) return;
      latestShortcutCheck.set({ status: "checked", shortcut, savedShortcut: saved, availability: { available: false, message: errorMessage(error, "Could not check this shortcut.") } });
    }
  };

  const recorder = createShortcutRecorder({
    onRecord: (shortcut) => void checkShortcut(shortcut),
    onStart: () => { shortcutCheckId++; latestShortcutCheck.set({ status: "idle", availability: null }); },
  });

  const shortcutStatus = (): string | null => {
    const check = shortcutCheck();
    if (recorder.recording()) return "Press your shortcut. Esc cancels.";
    const conflict = candidateConflict();
    if (conflict) return `R3 Code already uses this for "${commandLabel(conflict)}".`;
    if (check.status === "checking") return "Checking shortcut…";
    if (check.availability) return check.availability.available ? "Ready to save." : check.availability.message;
    const current = state();
    if (current?.mode === "portal" && !current.shortcutLabel && isModifierPairShortcut(displayShortcut())) return "Try a shortcut such as Ctrl+Shift+2.";
    return snapShotShortcutStatus(current);
  };

  const prepareSetup = async (requested: CaptureSetupStep | "resume") => {
    let current = await refreshState();
    if (!current) return;
    if (current.macPermissions) requested = "access";
    const wasEnabled = settings().snapShotEnabled;
    if (!wasEnabled && captureSetupInitialStep(current, requested) !== "access") {
      current = await save({ snapShotEnabled: true });
      if (!current) {
        // Settings may save before status checking fails; keep Finish later available to disable capture.
        chosenWizard.set({ initialStep: "access", wasEnabled: false });
        return;
      }
    }
    chosenWizard.set({ initialStep: captureSetupInitialStep(current, requested), wasEnabled });
  };

  const openSetup = async (requested: CaptureSetupStep | "resume" = "resume") => {
    if (!state() || setupBusy()) return;
    recorder.stopRecording();
    shortcutCheckId++;
    candidate.set(savedShortcut());
    latestShortcutCheck.set({ status: "idle", availability: null });
    setupError.set(null);
    setupBusy.set(true);
    try { await prepareSetup(requested); } finally { setupBusy.set(false); }
  };

  const enableForSetup = async (): Promise<boolean> => {
    if (setupBusy()) return false;
    setupBusy.set(true);
    setupError.set(null);
    try {
      const current = state();
      if (current?.macPermissions) {
        saveSnapShotSetupResume(wizard()?.wasEnabled ?? settings().snapShotEnabled);
        await setupSnapShot("test-mac-capture");
      }
      const next = settings().snapShotEnabled && !current?.message ? await refreshState() : await save({ snapShotEnabled: true });
      return next !== undefined && captureSetupAccessReady(next);
    } catch (error) {
      reportSetupError("Couldn't verify capture access", error);
      return false;
    } finally {
      setupBusy.set(false);
    }
  };

  const closeSetup = async (completed: boolean) => {
    const current = wizard();
    if (!current || setupBusy()) return;
    setupBusy.set(true);
    try {
      if (settings().snapShotEnabled && captureSetupShouldDisableOnClose(current.wasEnabled, completed)) {
        if (!(await save({ snapShotEnabled: false }))) return;
      }
      recorder.stopRecording();
      setupError.set(null);
      clearSnapShotSetupResume();
      chosenWizard.set(null);
    } catch (error) {
      reportSetupError("Couldn't close capture setup", error);
    } finally {
      setupBusy.set(false);
    }
  };

  const saveShortcut = async (): Promise<boolean> => {
    if (!canSaveShortcut() || setupBusy()) return false;
    setupBusy.set(true);
    try {
      const saved = await save({ snapShotShortcut: candidate() });
      return Boolean(saved?.shortcutRegistered || saved?.shortcutPending);
    } finally {
      setupBusy.set(false);
    }
  };

  const cancelShortcut = () => {
    recorder.stopRecording();
    shortcutCheckId++;
    candidate.set(savedShortcut());
    latestShortcutCheck.set({ status: "idle", availability: null });
  };

  const shortcutInput = () => <recorder.Input shortcut={displayShortcut()} disabled={setupBusy()} allowModifierPairs={state()?.mode !== "portal"} />;

  const enabledStatus = () => (setupBusy() && !wizard() ? "Updating capture settings…" : refreshError() ? `${refreshError()!.title}. ${refreshError()!.message}` : snapShotStatus(state(), settings().snapShotEnabled));

  return (
    <View>
      <SettingsSection title="SnapShots">
        {/* SettingsUnavailableGroup: never shown here, the bridge is always present. */}
        {unavailableMessage ? <Text class="px-4 py-2 text-xs text-muted-foreground">{unavailableMessage}</Text> : null}
        <Row
          id="snap-shot-enabled"
          title="SnapShots"
          description={snapShotDescription(state())}
          status={enabledStatus()}
          control={<>
            {settings().snapShotEnabled && !snapShotSetupComplete(state(), settings().snapShotIncludeAccessibility)
              ? <SmallButton label={snapShotSetupButtonLabel(state())} disabled={setupBusy()} onPress={() => void openSetup()} /> : null}
            <Toggle
              label="Enable snapshots"
              checked={settings().snapShotEnabled || Boolean(wizard())}
              disabled={!captureAvailable() || setupBusy()}
              onChange={(checked) => {
                if (!checked) void save({ snapShotEnabled: false });
                else if (state()?.windows) void save({ snapShotEnabled: true });
                else void openSetup();
              }}
            />
          </>}
        />
        {settings().snapShotEnabled && captureAvailable() ? <>
          <View class="h-px bg-border-50" />
          <Row
            id="snap-shot-accessibility"
            title="Include app text"
            description="Include text and controls when the app makes them available."
            status={snapShotAccessibilityUnavailableMessage(state())}
            control={<Toggle
              label="Include app text in snapshots"
              checked={!snapShotAccessibilityUnavailableMessage(state()) && settings().snapShotIncludeAccessibility}
              disabled={!captureAvailable() || Boolean(snapShotAccessibilityUnavailableMessage(state()))}
              onChange={(checked) => void saveIncludeAccessibility(checked)}
            />}
          />
          <View class="h-px bg-border-50" />
          <Row
            id="snap-shot-shortcut"
            title="Capture shortcut"
            description={state()?.linuxBackend === "picker" ? "Choose a window to capture from any app." : "Capture the window you're using without switching apps."}
            status={managedShortcut() ? undefined : shortcutStatus()}
            control={managedShortcut()
              ? <SmallButton label="Change shortcut" disabled={setupBusy()} onPress={() => void openSetup("shortcut")} />
              : <>
                {shortcutInput()}
                {shortcutChanged() ? <>
                  <SmallButton label={setupBusy() ? "Saving…" : "Save"} variant="primary" disabled={!canSaveShortcut() || setupBusy()} onPress={() => void saveShortcut()} />
                  <SmallButton label="Cancel" variant="ghost" disabled={setupBusy()} onPress={cancelShortcut} />
                </> : state()?.mode === "portal" && state()!.shortcutCanRetry !== false && !isModifierPairShortcut(savedShortcut())
                  ? <SmallButton label="Shortcut permissions" variant="ghost" disabled={setupBusy() || state()!.shortcutPending === true} onPress={() => void setup("retry-shortcut")} /> : null}
              </>}
          />
          <View class="h-px bg-border-50" />
          <Row
            id="snap-shot-sound"
            title="Capture sound"
            description="Choose the sound played when capture starts."
            control={<>
              <SettingsSelect
                label="Snapshot sound"
                value={soundSelection()}
                options={[{ value: "off", label: "Off" }, { value: "soft-pop", label: "Whoosh (Default)" }, { value: "camera-shutter", label: "Click" }]}
                onChange={(value) => void save(snapShotSoundPatch(value as SnapShotSoundSelection))}
              />
              {/* SnapShotSettings.tsx:507-527: each sound can be previewed. The web puts the play marks inside its menu; an
                  NSH Menu closes on any item press, so they sit beside the select. */}
              <View role="button" accessibilityLabel="Play Whoosh" tooltip="Play Whoosh" onPress={() => void playSnapShotSound("soft-pop")} class="size-7 items-center justify-center rounded-md hover:bg-accent"><SettingsIcon name="play" size={10} /></View>
              <View role="button" accessibilityLabel="Play Click" tooltip="Play Click" onPress={() => void playSnapShotSound("camera-shutter")} class="size-7 items-center justify-center rounded-md hover:bg-accent"><SettingsIcon name="play" size={10} /></View>
            </>}
          />
          <View class="h-px bg-border-50" />
          <Row
            id="snap-shot-flash"
            title="Capture flash"
            description="Show a gentle cue on the captured window."
            status={feedbackUnavailable()}
            control={<Toggle label="Flash captured window" checked={!feedbackUnavailable() && settings().snapShotFlash} disabled={!captureAvailable() || Boolean(feedbackUnavailable())} onChange={(checked) => void save({ snapShotFlash: checked })} />}
          />
          <View class="h-px bg-border-50" />
          <Row
            id="snap-shot-animations"
            title="Capture animations"
            description="Animate captured windows into your draft."
            status={feedbackUnavailable()}
            control={<Toggle label="Animate snapshots" checked={!feedbackUnavailable() && settings().snapShotAnimations} disabled={!captureAvailable() || Boolean(feedbackUnavailable())} onChange={(checked) => void save({ snapShotAnimations: checked })} />}
          />
        </> : null}
      </SettingsSection>
      {wizard() && state() ? (
        <SnapShotSetupDialog
          state={state()!}
          initialStep={wizard()!.initialStep}
          wasEnabled={wizard()!.wasEnabled}
          includeAccessibility={settings().snapShotIncludeAccessibility}
          busy={setupBusy()}
          error={(setupError() ?? refreshError())?.message ?? null}
          shortcutInput={shortcutInput}
          shortcutStatus={shortcutStatus()}
          shortcutChanged={shortcutChanged()}
          canSaveShortcut={canSaveShortcut()}
          onSaveShortcut={saveShortcut}
          onEnable={enableForSetup}
          onAction={setup}
          onRefresh={refreshState}
          onClose={closeSetup}
          onLeaveStep={recorder.stopRecording}
        />
      ) : null}
    </View>
  );
}
