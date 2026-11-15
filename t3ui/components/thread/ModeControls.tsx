// Permissions (runtime mode) and interaction mode controls, ported from
// ComposerFooterControls.tsx (ComposerFooterModeControls, ComposerPermissionsSection)
// and ComposerModelEffort.tsx (PermissionsMenu).
//
// The web app keeps Permissions inside the model picker's footer and shows a chip in the
// controls bar only while the thread's mode differs from the user's default.
import { ContextLabel } from "./ContextLabel";
import { overGlass } from "../composer/tokenColor";
import { signal, Text, View } from "nsh";
import { backendUrl, openThread, settingValue } from "../../store";
import type { InteractionMode, RuntimeMode } from "../../store";
import { ComposerIcon } from "../composer/ComposerIcon";
import { createAnchor, Popup } from "../composer/Popover";
import type { Content } from "../composer/Popover";
import { INTERACTION_LABELS, runtimeModeConfig, runtimeModeOptions } from "../composer/runtimeModeConfig";
import { listedRuntimeModes } from "../../store";
import { serverManagedPolicy } from "../../pages/settings/settingsState";
import { permissionsOpenIn, setPermissionsOpen } from "../composer/composerControls";

export type RuntimeChoice = RuntimeMode;
export type InteractionChoice = InteractionMode;

export type RestingCollapse = "natural" | "icon" | "overflow";

/** The mode a new thread starts in: the user's setting, else full access. */
export function defaultRuntimeChoice(): RuntimeChoice {
  const configured = settingValue("defaultRuntimeMode");
  return typeof configured === "string" && configured in runtimeModeConfig ? (configured as RuntimeChoice) : "full-access";
}

/** The chip shows only while the mode differs from the default (resolveComposerControlsOwnership). */
export function showsPermissionsChip(runtime: RuntimeChoice, defaultMode: RuntimeChoice): boolean {
  return runtime !== defaultMode;
}

/** Permission modes as one segmented toggle with the shown mode named below. */
export function PermissionsSection(props: {
  runtime: () => RuntimeChoice;
  available: () => RuntimeChoice[];
  onPick: (mode: RuntimeChoice) => void;
}) {
  const preview = signal<RuntimeChoice | null>(null);
  const shownMode = () => preview() ?? props.runtime();
  // resolveRuntimeModeOptions: modes above the administrator's ceiling stay listed, disabled, with the reason.
  const options = () => {
    const listed = runtimeModeOptions(listedRuntimeModes(), serverManagedPolicy());
    return listed.filter((option) => option.disabledReason !== undefined || props.available().includes(option.mode));
  };
  const reasonOf = (mode: RuntimeChoice) => options().find((option) => option.mode === mode)?.disabledReason;
  return (
    <View class="w-72 gap-1.5 px-2 py-1.5" accessibilityLabel="Permissions">
      <Text class="text-xs font-medium text-muted-foreground">Permissions</Text>
      <View class="flex-row rounded-lg bg-input-32 p-0.5">
        <Each of={options().map((option) => option.mode)} key={(mode) => mode}>
          {(mode) => (
            <View
              class={`h-6 flex-1 items-center justify-center rounded-md ${reasonOf(mode()) !== undefined ? "opacity-40" : props.runtime() === mode() ? "bg-accent" : "hover:bg-accent-50"}`}
              disabled={reasonOf(mode()) !== undefined}
              accessibilityHint={reasonOf(mode()) ?? runtimeModeConfig[mode()].description}
              onPress={() => { if (reasonOf(mode()) === undefined && mode() !== props.runtime()) props.onPick(mode()); }}
              onMouseEnter={() => preview.set(mode())}
              onMouseLeave={() => { if (preview() === mode()) preview.set(null); }}
              accessibilityLabel={runtimeModeConfig[mode()].label}
              role="button"
            >
              <ComposerIcon name={runtimeModeConfig[mode()].icon} size={14} tint={props.runtime() === mode() ? "#f5f5f5" : undefined} />
            </View>
          )}
        </Each>
      </View>
      <View class="gap-0.5">
        <Text class={shownMode() === props.runtime() ? "text-sm text-foreground" : "text-sm text-muted-foreground"}>{runtimeModeConfig[shownMode()].label}</Text>
        <Text class="min-h-8 text-xs text-muted-foreground">{reasonOf(shownMode()) ?? runtimeModeConfig[shownMode()].description}</Text>
      </View>
    </View>
  );
}

/** Default / Plan, as one segmented row. Only providers that support plan show it. */
export function InteractionToggle(props: {
  interaction: () => InteractionChoice;
  available: () => InteractionChoice[];
  onPick: (mode: InteractionChoice) => void;
}) {
  return (
    <View class="flex-row rounded-md bg-input-32 p-0.5" accessibilityLabel="Interaction mode">
      <Each of={props.available()} key={(mode) => mode}>
        {(mode) => (
          <View
            class={`h-6 items-center justify-center rounded-md px-2 ${props.interaction() === mode() ? "bg-accent" : "hover:bg-accent-50"}`}
            onPress={() => { if (mode() !== props.interaction()) props.onPick(mode()); }}
            accessibilityLabel={`Interaction mode: ${INTERACTION_LABELS[mode()]}`}
            role="button"
          >
            <Text class={`text-xs ${props.interaction() === mode() ? "text-foreground" : "text-muted-foreground"}`}>{INTERACTION_LABELS[mode()]}</Text>
          </View>
        )}
      </Each>
    </View>
  );
}

/** The permissions popover trigger; `chip` styles it as the bar's control, else as the picker footer's. */
function PermissionsTrigger(props: {
  runtime: () => RuntimeChoice;
  available: () => RuntimeChoice[];
  disabled: () => boolean;
  onPick: (mode: RuntimeChoice) => void;
  chip: boolean;
  /** The context strip's xs control (ComposerContextPermissions): size-3 icon, text-xs, muted. */
  strip?: boolean;
  /** useRestingComposerControlsLayout: the chip's label hides ("icon"), or the chip moves into the "More composer controls" overflow. */
  collapse?: () => RestingCollapse;
}) {
  const slot = props.chip || props.strip ? "chip" : "footer";
  // Shared with composer.mode, which opens whichever of the two the web shows.
  const open = Object.assign(() => permissionsOpenIn() === slot, { set: (value: boolean) => setPermissionsOpen(slot, value) });
  const anchor = createAnchor();
  const config = () => runtimeModeConfig[props.runtime()];
  return (
    <View>
      <View
        ref={anchor.ref}
        class={props.strip
          ? "h-6 flex-row items-center gap-1 rounded-md px-1.75 hover:bg-accent"
          : props.chip
          ? "h-7 flex-row items-center gap-1.5 rounded-md ps-1.5 pe-2 hover:bg-accent"
          : "h-7 flex-row items-center gap-1.5 rounded-md px-2 hover:bg-accent"}
        onPress={() => { if (!props.disabled()) open.set(!open()); }}
        disabled={props.disabled()}
        accessibilityLabel={props.collapse?.() === "overflow" ? "More composer controls" : `Permissions: ${config().label}`}
        role="button"
      >
        <ComposerIcon name={props.collapse?.() === "overflow" ? "ellipsis" : config().icon} size={props.strip ? 12 : props.chip ? 16 : 14} />
        {props.collapse && props.collapse() !== "natural" ? null : props.strip ? <ContextLabel text={() => config().label} /> : <Text class={props.chip ? "text-sm font-medium text-foreground" : "text-xs text-muted-foreground"}>{config().label}</Text>}
        {props.chip || props.strip ? null : <ComposerIcon name="chevron-up" size={12} />}
      </View>
      {open() ? (
        <Popup anchor={anchor.anchor} onClose={() => open.set(false)} placement="top" align={props.chip && !props.strip ? "start" : "end"}>
          <PermissionsSection
            runtime={props.runtime}
            available={props.available}
            onPick={(mode) => { props.onPick(mode); open.set(false); }}
          />
        </Popup>
      ) : null}
    </View>
  );
}

/** The picker footer (ComposerPickerFooter): speed and Ultracode on the left, the Permissions menu right-aligned. The reference has no interaction-mode control here, so `interaction*` props are accepted but unused. */
export function PickerFooter(props: {
  disabled: () => boolean;
  runtime: () => RuntimeChoice;
  availableRuntime: () => RuntimeChoice[];
  interaction: () => InteractionChoice;
  availableInteraction: () => InteractionChoice[];
  onRuntime: (mode: RuntimeChoice) => void;
  onInteraction: (mode: InteractionChoice) => void;
  /** Speed and Ultracode segments, ahead of the interaction toggle. */
  leading?: Content;
}) {
  return (
    <View class="flex-row flex-wrap items-center gap-2 border-t border-border-70 px-3 py-2" style={{ backgroundColor: overGlass("muted", 0.4) }}>
      {props.leading ?? null}
      <View class="flex-1" />
      {props.availableRuntime().length > 0 ? (
        <PermissionsTrigger runtime={props.runtime} available={props.availableRuntime} disabled={props.disabled} onPick={props.onRuntime} chip={false} />
      ) : null}
    </View>
  );
}

/** The controls bar's permissions chip: visible only while the mode differs from the default. */
export function ModeControls(props: {
  disabled: () => boolean;
  runtime: () => RuntimeChoice;
  availableRuntime: () => RuntimeChoice[];
  onRuntime: (mode: RuntimeChoice) => Promise<void>;
  /** Defaults to the user's `defaultRuntimeMode` setting. */
  defaultRuntime?: () => RuntimeChoice;
  /** The context strip names the permissions on a new thread, so the footer does not repeat them. */
  shownInStrip?: () => boolean;
  /** The resting-controls collapse step the composer measured (composerFooterLayout). */
  collapse?: () => RestingCollapse;
}) {
  const errors = signal<Record<string, string>>({});
  const pending = signal<Record<string, boolean>>({});
  const scope = () => JSON.stringify([backendUrl(), openThread()?.id ?? ""]);
  async function apply(mode: RuntimeChoice) {
    const environment = backendUrl();
    const id = openThread()?.id;
    if (!id) return;
    const key = JSON.stringify([environment, id]);
    if (pending()[key] || props.disabled()) return;
    pending.update((all) => ({ ...all, [key]: true }));
    errors.update((all) => ({ ...all, [key]: "" }));
    try { await props.onRuntime(mode); }
    catch (cause) {
      errors.update((all) => ({ ...all, [key]: cause instanceof Error ? cause.message : String(cause) }));
    } finally { pending.update((all) => ({ ...all, [key]: false })); }
  }
  const visible = () => !(props.shownInStrip?.() ?? false) && props.availableRuntime().length > 0 && showsPermissionsChip(props.runtime(), (props.defaultRuntime ?? defaultRuntimeChoice)());
  return (
    <>
      {visible() ? (
        <PermissionsTrigger
          runtime={props.runtime}
          available={props.availableRuntime}
          disabled={() => props.disabled() || Boolean(pending()[scope()])}
          onPick={(mode) => void apply(mode)}
          chip
          collapse={props.collapse}
        />
      ) : null}
      {errors()[scope()] ? <Text class="text-xs text-error-foreground">{errors()[scope()]}</Text> : null}
    </>
  );
}

/** The permissions control at the end of a new thread's context strip. */
export function StripPermissions(props: {
  runtime: () => RuntimeChoice;
  available: () => RuntimeChoice[];
  disabled: () => boolean;
  onPick: (mode: RuntimeChoice) => void;
}) {
  return props.available().length > 0 ? (
    <PermissionsTrigger runtime={props.runtime} available={props.available} disabled={props.disabled} onPick={props.onPick} chip={false} strip />
  ) : null;
}
