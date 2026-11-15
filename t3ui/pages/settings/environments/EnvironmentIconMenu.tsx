// EnvironmentIconPicker.tsx: the "Icon" choices of a machine's "More actions" menu. It picks the mark an
// environment shows (`environmentIcon` in ServerSettings, null while the pick is what the server detected).
// The web nests them in a submenu; the runner this app is tested on draws no `Submenu`, so they sit under an
// "Icon" heading in the same menu.
import { Text, View } from "nsh";
import { MenuItem, MenuSeparator } from "nsh/base";
import { writeSetting } from "../settingsSync";
import { SettingsIcon } from "../SettingsIcon";
import { ENVIRONMENT_MACHINE_KIND_LABELS, ENVIRONMENT_MACHINE_KINDS, isEnvironmentMachineKind, MachineIcon, resolveEnvironmentMachineKind, type EnvironmentMachineKind } from "./MachineIcon";
import { MENU_ITEM_ICON_SIZE, MENU_ITEM_ROW_CLASS } from "../../../components/menuStyles";

/** Why the icon cannot be changed, or null (resolveEnvironmentIconPickerLock). */
export function resolveEnvironmentIconPickerLock(input: { hasConfig: boolean; operateAccess: "granted" | "denied" | "pending" }): string | null {
  if (!input.hasConfig) return "Connect to this environment to change its icon.";
  if (input.operateAccess !== "granted") return "Your session on this environment cannot change its settings.";
  return null;
}

/** What a pick writes: the detected kind clears the setting, any other kind is stored. */
export function environmentIconWrite(next: EnvironmentMachineKind, detected: EnvironmentMachineKind): EnvironmentMachineKind | null {
  return next === detected ? null : next;
}

const ITEM_CLASS = MENU_ITEM_ROW_CLASS;

export function EnvironmentIconMenu(props: {
  /** The server's config: `settings.environmentIcon` and `environment.platform.machine`. Null while disconnected. */
  config: { environment?: { platform?: { machine?: unknown } } | null; settings?: { environmentIcon?: unknown } | null } | null;
  operateAccess: "granted" | "denied" | "pending";
}) {
  const lock = () => resolveEnvironmentIconPickerLock({ hasConfig: props.config !== null, operateAccess: props.operateAccess });
  const resolved = () => resolveEnvironmentMachineKind(props.config);
  const detectedValue = () => props.config?.environment?.platform?.machine;
  const detected = (): EnvironmentMachineKind => (isEnvironmentMachineKind(detectedValue()) ? (detectedValue() as EnvironmentMachineKind) : "server");
  return (
    <>
      <View class={MENU_ITEM_ROW_CLASS} accessibilityLabel="Icon">
        <MachineIcon kind={resolved()} size={MENU_ITEM_ICON_SIZE} />
        <Text class="min-w-0 flex-1 text-sm font-medium text-muted-foreground">Icon</Text>
      </View>
      {lock() !== null ? (
        <>
          <MenuItem disabled class={MENU_ITEM_ROW_CLASS}><Text class="max-w-56 text-sm text-muted-foreground">{lock()!}</Text></MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      {ENVIRONMENT_MACHINE_KINDS.map((kind) => (
        <MenuItem
          role="menuitemradio"
          checked={resolved() === kind}
          disabled={lock() !== null}
          accessibilityLabel={ENVIRONMENT_MACHINE_KIND_LABELS[kind]}
          class={ITEM_CLASS}
          onSelect={() => { if (lock() === null) void writeSetting("environmentIcon", "server", environmentIconWrite(kind, detected())); }}
        >
          <MachineIcon kind={kind} size={MENU_ITEM_ICON_SIZE} />
          <Text class="min-w-0 flex-1 truncate text-sm text-popover-foreground">{ENVIRONMENT_MACHINE_KIND_LABELS[kind]}</Text>
          {kind === detected() ? <Text class="text-xs text-muted-foreground">{detectedValue() ? "detected" : "default"}</Text> : null}
          {resolved() === kind ? <SettingsIcon name="check" size={MENU_ITEM_ICON_SIZE} /> : null}
        </MenuItem>
      ))}
    </>
  );
}
