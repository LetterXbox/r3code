// DeviceTabs: the Devices segmented toggle above the provider card (ProviderSettingsPanel's deviceTabs): one tab per
// device with its machine mark, name and, while it is not connected, a status dot. Hidden with only the primary device.
import { Text, View } from "nsh";
import { SettingsIcon } from "../SettingsIcon";
import type { ProviderDevice } from "./data";
import { Tip } from "./ui";

const DOT: Record<ProviderDevice["phase"], string> = { connected: "#22c55e", checking: "#ffb900", failed: "#ff6467", off: "#969ca6" };
export const PHASE_TITLE: Record<ProviderDevice["phase"], string> = { connected: "Connected", checking: "Connecting", failed: "Connection failed", off: "Disabled" };

/** onlyPrimaryDevice: one primary device (or none) needs no tabs. */
export function showDeviceTabs(devices: readonly ProviderDevice[]): boolean {
  return devices.length > 0 && !(devices.length === 1 && devices[0]?.primary === true);
}

export function DeviceTabs(props: { devices: ProviderDevice[]; selectedId: string; onSelect: (id: string) => void }) {
  return <View class="min-h-11 min-w-0 flex-row items-center px-4" testID="Provider device tabs">
    <View class="min-w-0 flex-1 flex-row overflow-hidden">
      <View accessibilityLabel="Devices" role="tablist" class="my-2 flex-row items-center gap-0.5 rounded-lg bg-segmented-track p-0.5">
        <Each of={props.devices} key={(device) => device.id}>{(device) => <View accessibilityLabel={`${device().label}, ${device().detail}, ${PHASE_TITLE[device().phase]}`} role="tab" accessibilityState={{ selected: device().id === props.selectedId }}
          onPress={() => props.onSelect(device().id)} class={device().id === props.selectedId ? "h-7 flex-row items-center gap-1.5 rounded-md bg-segmented-active px-2.5 transition-colors duration-150 ease-in-out" : "h-7 flex-row items-center gap-1.5 rounded-md px-2.5 hover:bg-segmented-hover transition-colors duration-150 ease-in-out"}
          tooltip={<Tip label={`${device().detail} · ${PHASE_TITLE[device().phase]}`} />}>
          <SettingsIcon name={device().primary ? "monitor" : "server"} size={14} />
          <Text class={device().id === props.selectedId ? "max-w-40 truncate text-xs font-medium text-foreground" : "max-w-40 truncate text-xs text-muted-foreground"}>{device().label}</Text>
          {device().phase !== "connected" ? <View class="size-1.5 rounded-full" style={{ backgroundColor: DOT[device().phase] }} /> : null}
        </View>}</Each>
      </View>
    </View>
  </View>;
}
