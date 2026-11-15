// LoadBalancingSettings.tsx: whether new threads in shared projects pick the least loaded machine, and how much each machine
// is preferred. Shown on the Environments page only when two or more environments are connected.
import { Text, View } from "nsh";
import { Select, Switch } from "nsh/base";
import { EnvironmentRow } from "../environments/EnvironmentRow";
import { clientSettings, clientSettingsHydrated, updateClientSettings } from "./clientSettings";
import { FoldedSettingsSection, UiIcon } from "./ui";

export const LOAD_PREFERENCES = [
  { value: 100, label: "Prefer" },
  { value: 50, label: "Normal" },
  { value: 25, label: "Less often" },
  { value: 0, label: "Manual only" },
] as const;
export type LoadPreference = (typeof LOAD_PREFERENCES)[number]["value"];

export function loadPreferenceForWeight(weight: number | undefined): LoadPreference {
  if (weight === undefined || weight === 50) return 50;
  if (weight === 0) return 0;
  return weight < 50 ? 25 : 100;
}
function preferenceLabel(preference: LoadPreference): string { return LOAD_PREFERENCES.find((entry) => entry.value === preference)?.label ?? "Normal"; }

export function summarizeLoadPreferences(environments: ReadonlyArray<{ environmentId: string; label: string }>, weights: Readonly<Record<string, number>>): string | null {
  const parts = environments.flatMap((environment) => {
    const preference = loadPreferenceForWeight(weights[environment.environmentId]);
    return preference === 50 ? [] : [`${environment.label} ${preferenceLabel(preference).toLowerCase()}`];
  });
  return parts.length === 0 ? null : parts.join(" · ");
}

export interface LoadBalancingEnvironment { environmentId: string; label: string; subtitle: string; kind: "desktop" | "server" }

export function LoadBalancingSettings(props: { environments: ReadonlyArray<LoadBalancingEnvironment> }) {
  const settings = () => clientSettings();
  const ready = () => clientSettingsHydrated();
  return <View>{props.environments.length < 2 ? null : <FoldedSettingsSection title="Load balancing" testID="Load balancing"
    summary={settings().loadBalancingEnabled ? summarizeLoadPreferences(props.environments, settings().loadBalancingWeights) : "Off"}
    control={<Switch checked={settings().loadBalancingEnabled} disabled={!ready()} onChange={(event: { checked?: boolean }) => updateClientSettings({ loadBalancingEnabled: event.checked === true })}
      accessibilityLabel="Automatically balance load" testID={`Automatically balance load ${settings().loadBalancingEnabled ? "on" : "off"}`}
      class="h-[18px] w-[30px] items-center" trackClass="h-[18px] w-[30px] justify-center rounded-full bg-input checked:bg-primary transition-colors duration-200 ease-in-out" thumbClass="size-3.5 rounded-full bg-background checked:translate-x-3 transition-transform duration-150 ease-in-out" />}>
    <View class="px-4 py-2.5"><Text class="text-xs text-muted-foreground">New threads in shared projects start on the machine with the most free CPU and memory, weighted by each machine's preference.</Text></View>
    <Each of={props.environments} key={(environment) => environment.environmentId}>{(environment) => <View class="border-t border-border-50">
      <EnvironmentRow kind={environment().kind} label={environment().label} subtitle={environment().subtitle}>
        <Select value={String(loadPreferenceForWeight(settings().loadBalancingWeights[environment().environmentId]))} disabled={!ready() || !settings().loadBalancingEnabled}
          items={LOAD_PREFERENCES.map((entry) => ({ value: String(entry.value), title: entry.label }))}
          onChange={(event: { value: string | null }) => {
            if (event.value === null) return;
            updateClientSettings({ loadBalancingWeights: { ...settings().loadBalancingWeights, [environment().environmentId]: Number(event.value) } });
          }}
          trigger={<View accessibilityLabel={`${environment().label} load preference`} testID={`${environment().label} load preference = ${preferenceLabel(loadPreferenceForWeight(settings().loadBalancingWeights[environment().environmentId]))}`}
            class={`h-6 w-32 flex-row items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 hover:bg-accent ${!ready() || !settings().loadBalancingEnabled ? "opacity-64" : ""}`}>
            <Text class="flex-1 text-xs text-foreground">{preferenceLabel(loadPreferenceForWeight(settings().loadBalancingWeights[environment().environmentId]))}</Text>
            <UiIcon name="chevron-down" size={14} />
          </View>}
          itemClass="min-h-7 flex-row items-center rounded-sm px-2 text-sm focus:bg-accent hover:bg-accent" popupClass="min-w-32 rounded-lg border border-border bg-popover-84 p-1" class="h-6 w-32" />
      </EnvironmentRow>
    </View>}</Each>
  </FoldedSettingsSection>}</View>;
}

