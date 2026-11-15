// Controls for the generated rows that carry no `field`: the extractor sees
// their JSX but not what they are bound to, so the few that have a real source
// are named here by row id (About's Version, Update track and Privacy policy).
import { openUrl, signal, Text, token, View } from "nsh";
import { Menu, MenuItem } from "nsh/base";
import { Icon } from "../../components/Icons";
import { SettingsButton, SettingsSelect } from "../../components/SettingsLayout";
import { trackOpenChange, useOverlayOpen } from "../../components/rightPanel/nativeOcclusion";
import { MENU_POPUP_CLASS } from "../../components/menuStyles";
import {
  isDefaultThreadDetailsVisibility, resetThreadDetailsItems, setThreadDetailsItemVisible,
  THREAD_DETAILS_ITEMS, threadDetailsVisibility,
} from "../../components/header/threadDetailsItems";
import { settingValue, updateSetting } from "../../store";
import { serverEnvironment, serverSettings } from "./settingsState";
import { isProjectScope } from "./scopeState";
import { DeleteNowControl } from "./Storage";
import { ModelSelectionControl } from "./ModelSelectionControl";
import { resetSnoozeOptions, snoozeOptionsChanged } from "./fidelity/SnoozeOptions";
import {
  DefaultModelControl, FALLBACK_DESCRIPTION, FallbackModelControl, NEW_THREADS_RESETS, PermissionsControl, WorkspaceControl,
  defaultModelDescription, permissionsDescription, workspaceDescription,
} from "./NewThreadsControls";
import { BrowserProfilesControl } from "./BrowserProfiles";
import { BackgroundActivityControl } from "./BackgroundActivityControl";
import { backgroundDescription, isDefaultPolicy, resetPatch } from "./backgroundActivity";
import { writeScopedPatch } from "./scopeState";
import { DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE, environmentIdentificationDescription, environmentIdentificationOptions, resolveSidebarStageBackdropVariant, savedMode, stageLabel } from "./environmentIdentification";
import { BrowserViewportControl, browserViewportChanged, resetBrowserViewport } from "./BrowserViewportControl";

// legalLinks.ts
const PRIVACY_POLICY_URL = "https://t3.codes/privacy-policy";

/** The running server's version, which is what this client talks to. */
export function appVersionLabel(): string {
  const version = serverEnvironment()?.serverVersion;
  return typeof version === "string" && version.length > 0 ? version : "Unknown";
}

function UpdateTrack() {
  const value = () => (settingValue("updateChannel") === "nightly" ? "nightly" : "latest");
  return (
    <SettingsSelect
      label="Update track"
      value={value()}
      options={[{ value: "latest", label: "Latest" }, { value: "nightly", label: "Nightly" }]}
      onChange={(next) => updateSetting("updateChannel", next)}
    />
  );
}

/**
 * The microphone choice. The web lists `navigator.mediaDevices.enumerateDevices()`; this client has
 * no way to list input devices, so the system default (the web's own first and only entry when
 * no device is reported) is the one choice, and a device id saved elsewhere is shown as such.
 */
function Microphone() {
  const stored = () => String(settingValue("voiceMicrophone") ?? "");
  const SYSTEM_DEFAULT = "system-default";
  const options = () => [{ value: SYSTEM_DEFAULT, label: "System default" }, ...(stored() ? [{ value: stored(), label: stored() }] : [])];
  return <SettingsSelect label="Microphone" value={stored() || SYSTEM_DEFAULT} options={options()} onChange={(next) => updateSetting("voiceMicrophone", next === SYSTEM_DEFAULT ? "" : next)} />;
}

/** The Environment identification select: its options and the label of `artwork` follow the running stage (AppearanceSettingsPanel.tsx). */
function EnvironmentIdentification() {
  return (
    <SettingsSelect
      label="Environment identification"
      value={savedMode()}
      options={[...environmentIdentificationOptions(resolveSidebarStageBackdropVariant(stageLabel()))]}
      compactWidth={160}
      onChange={(next) => updateSetting("environmentIdentificationMode", next)}
    />
  );
}

/** The "Choose what to show" button (ThreadDetailsItemsRow.tsx): a compact outline button reading
 * "N of M on", opening the same checkable items menu as the thread details card's own right-click.
 * Anchored to the button (`nsh/base`'s `Menu` with a `trigger`, as every other settings menu/select
 * in this file is — ScopeSentence.tsx's `ScopeMenu` is the same shape), not an unanchored
 * `Menu.popup(items, at)` call. */
function ThreadDetailsItemsControl() {
  const open = signal(false);
  useOverlayOpen(open, "settings thread details items");
  const enabled = () => THREAD_DETAILS_ITEMS.filter((item) => threadDetailsVisibility()[item.id]).length;
  return (
    <Menu
      popupClass={`${MENU_POPUP_CLASS} shadow-lg`}
      align="end"
      onOpenChange={trackOpenChange(open)}
      trigger={
        <View
          accessibilityLabel={`Thread details: ${enabled()} of ${THREAD_DETAILS_ITEMS.length} on`}
          class="h-7 flex-row items-center justify-between gap-1.5 rounded-lg border border-input bg-background px-[9px] dark:bg-input-32"
          style={{ width: 160 }}
        >
          <Text class="min-w-0 flex-1 text-sm text-foreground">{enabled()} of {THREAD_DETAILS_ITEMS.length} on</Text>
          <View class="-mr-1 opacity-70">
            <Icon name="chevron-down" size={14} tint={token("icon-muted")} />
          </View>
        </View>
      }
    >
      {THREAD_DETAILS_ITEMS.map((item) => {
        const checked = () => threadDetailsVisibility()[item.id];
        return (
          <MenuItem
            accessibilityLabel={item.label}
            class="min-h-7 flex-row items-center justify-between gap-4 rounded-sm px-2 py-1 text-sm text-popover-foreground hover:bg-accent"
            closeOnSelect={false}
            onSelect={() => setThreadDetailsItemVisible(item.id, !checked())}
          >
            <Text class="text-sm text-popover-foreground">{item.label}</Text>
            {checked() ? <Icon name="check" size={14} tint={token("popover-foreground")} /> : null}
          </MenuItem>
        );
      })}
    </Menu>
  );
}

const STATIC_CONTROLS: Record<string, () => any> = {
  "environment-identification": () => <EnvironmentIdentification />,
  "thread-details-items": () => <ThreadDetailsItemsControl />,
  "app-version": () => <Text class="text-sm text-muted-foreground" testID="App version">{appVersionLabel()}</Text>,
  "update-track": () => <UpdateTrack />,
  "storage-delete-now": () => <DeleteNowControl />,
  "browser-default-viewport": () => <BrowserViewportControl />,
  "voice-microphone": () => <Microphone />,
  // The snooze list is drawn under the row (Panel.tsx), not at its right.
  "snooze-options": () => null,
  "text-generation-model": () => <ModelSelectionControl field="textGenerationModelSelection" label="Text generation model" dedicated={false} />,
  "source-control-writer-model": () => <ModelSelectionControl field="sourceControlWriterModelSelection" label="Source control writer model" switchLabel="Use a separate source control writer model" dedicated />,
  "review-guide-model": () => <ModelSelectionControl field="reviewGuideModelSelection" label="Review guide model" switchLabel="Use a separate review guide model" dedicated />,
  "speech-post-processing-model": () => <ModelSelectionControl field="speechPostProcessingModelSelection" label="Cleanup model" switchLabel="Use a separate cleanup model" dedicated />,
  "default-model": () => <DefaultModelControl />,
  "fallback-model": () => <FallbackModelControl />,
  "default-permissions": () => <PermissionsControl />,
  "new-threads": () => <WorkspaceControl />,
  "background-activity": () => <BackgroundActivityControl />,
  "browser-profiles": () => <BrowserProfilesControl />,
  "privacy-policy": () => <SettingsButton label="View policy" onPress={() => void openUrl(PRIVACY_POLICY_URL).catch(() => undefined)} />,
};

/** Rows whose own control shows the reset mark: whether the value differs, and the write that undoes it. */
const STATIC_RESETS: Record<string, { differs: () => boolean; reset: () => void; /** The settings keys the row edits: in a project scope its reset clears the project's override. */ keys?: string[] }> = {
  "environment-identification": { differs: () => savedMode() !== DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE, reset: () => updateSetting("environmentIdentificationMode", DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE) },
  "thread-details-items": { differs: () => !isDefaultThreadDetailsVisibility(threadDetailsVisibility()), reset: resetThreadDetailsItems },
  ...NEW_THREADS_RESETS,
  "background-activity": { keys: ["backgroundActivity"], differs: () => !isDefaultPolicy(serverSettings() as Record<string, unknown> | null), reset: () => void writeScopedPatch(resetPatch()) },
  "browser-default-viewport": { differs: browserViewportChanged, reset: resetBrowserViewport },
  "snooze-options": { differs: snoozeOptionsChanged, reset: resetSnoozeOptions },
};

/** Descriptions the web computes from the scope or the value rather than writing out. */
const STATIC_DESCRIPTIONS: Record<string, () => string> = {
  "environment-identification": environmentIdentificationDescription,
  "default-model": defaultModelDescription,
  "fallback-model": () => FALLBACK_DESCRIPTION,
  "default-permissions": permissionsDescription,
  "new-threads": workspaceDescription,
  "background-activity": () => backgroundDescription(serverSettings() as Record<string, unknown> | null),
  "automatic-pull": () => isProjectScope()
    ? "Keeps this project's default branch current when the checkout has no local changes or commits."
    : "Keeps the default branch current when the checkout has no local changes or commits. Projects can override it.",
  // SettingsPanels.tsx: the second sentence names the opposite-for-one-message shortcut, which
  // depends on the chosen Send shortcut (the extractor only sees the dynamic expression's first branch).
  "follow-up-behavior": () => {
    const shortcut = String(settingValue("sendShortcut") ?? "enter");
    const opposite = shortcut === "mod-enter-multiline"
      ? "Press ⌘ + Enter for single-line prompts or ⌘ + ⇧ + Enter for multiline prompts to do the opposite for one message."
      : `Press ⌘${shortcut === "mod-enter" ? " + ⇧" : ""} + Enter to do the opposite for one message.`;
    return `Queue follow-ups while the agent runs or steer the current run. ${opposite}`;
  },
  "pull-request-merge-method": () => isProjectScope()
    ? "Pull requests in this project start with this method."
    : "Pull requests start with this method. Last selected reuses whatever you chose most recently on this device.",
};

export function staticDescriptionFor(id: string | null): string | null {
  return id && STATIC_DESCRIPTIONS[id] ? STATIC_DESCRIPTIONS[id]!() : null;
}

export function staticResetFor(id: string | null) {
  return id ? STATIC_RESETS[id] ?? null : null;
}

export function staticControlFor(id: string | null): (() => any) | null {
  return id ? STATIC_CONTROLS[id] ?? null : null;
}

export function StaticControl(props: { id: string }) {
  const render = STATIC_CONTROLS[props.id];
  return render ? <View>{render()}</View> : null;
}
