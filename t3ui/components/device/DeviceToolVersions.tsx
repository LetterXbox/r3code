// DeviceToolVersions.tsx: the version trigger after the Devices rows' descriptions ("Hub: v0.12.0") and its popover,
// a Running / Required / Installed table per tool, "Versions have not been checked." before the hub reported any, the
// owner line and the row's Update / Check versions actions (IntegrationsSettings versionActions).
import { signal, Text, View } from "nsh";
import { Popover } from "nsh/base";
import { trackOpenChange, useOverlayOpen } from "../rightPanel/nativeOcclusion";

export interface DeviceToolVersion { runningVersion?: string | null; requiredVersion: string; installedVersions: string[] }
export interface DeviceToolVersionsData { hub: DeviceToolVersion; agent: DeviceToolVersion }
export type DeviceToolKind = keyof DeviceToolVersionsData;

/** Reads the wire `tools` of a host (anything malformed reads as not checked). */
export function readDeviceToolVersions(value: unknown): DeviceToolVersionsData | undefined {
  if (!value || typeof value !== "object") return undefined;
  const read = (tool: unknown): DeviceToolVersion | undefined => {
    if (!tool || typeof tool !== "object") return undefined;
    const t = tool as Record<string, unknown>;
    if (typeof t.requiredVersion !== "string" || !Array.isArray(t.installedVersions)) return undefined;
    return { runningVersion: typeof t.runningVersion === "string" ? t.runningVersion : null, requiredVersion: t.requiredVersion, installedVersions: t.installedVersions.filter((v): v is string => typeof v === "string") };
  };
  const hub = read((value as Record<string, unknown>).hub);
  const agent = read((value as Record<string, unknown>).agent);
  return hub && agent ? { hub, agent } : undefined;
}

/** The running version, else the required one when installed, else the highest installed (numeric order). */
export function deviceToolVersion(selected: DeviceToolVersion | undefined): string | undefined {
  if (!selected) return undefined;
  if (selected.runningVersion) return selected.runningVersion;
  if (selected.installedVersions.includes(selected.requiredVersion)) return selected.requiredVersion;
  return [...selected.installedVersions].sort(compareNumeric).at(-1);
}

/** `localeCompare(b, undefined, { numeric: true })`, which this runtime's engine does not implement: digit runs compare by value. */
export function compareNumeric(a: string, b: string): number {
  const split = (s: string) => s.match(/\d+|\D+/g) ?? [];
  const x = split(a), y = split(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i]!, q = y[i]!;
    const d = /^\d/.test(p) && /^\d/.test(q) ? Number(p) - Number(q) : p < q ? -1 : p > q ? 1 : 0;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

export const deviceToolName = (kind: DeviceToolKind | undefined) => (kind === "hub" ? "Device hub" : "Agent device");

export function deviceToolTrigger(tools: DeviceToolVersionsData | undefined, kind: DeviceToolKind | undefined, error?: string): { text: string; label: string | undefined } {
  if (!kind) return { text: error ? "Versions unavailable" : "Versions", label: undefined };
  const selected = tools?.[kind];
  const version = deviceToolVersion(selected);
  return {
    text: version ? `v${version}` : selected ? "Not installed" : "Version unknown",
    label: `${deviceToolName(kind)}: ${version ? `version ${version}` : selected ? "not installed" : "version unknown"}. Show details`,
  };
}

/** The table rows: [name, Running, Required, Installed]. */
export function deviceToolRows(tools: DeviceToolVersionsData, kind?: DeviceToolKind): [string, string, string, string][] {
  return ([["Device hub", tools.hub], ["Agent device", tools.agent]] as const)
    .filter(([name]) => !kind || name === deviceToolName(kind))
    .map(([name, tool]) => [name, tool.runningVersion ?? "Not running", tool.requiredVersion, tool.installedVersions.join(", ") || "None"]);
}

export const deviceToolFooter = (owner?: string) => `${owner ? `Managed by ${owner}. ` : ""}Tools update automatically on this host when needed.`;

export function DeviceToolVersions(props: { tools: DeviceToolVersionsData | undefined; kind?: DeviceToolKind; owner?: string; error?: string; action?: any }) {
  const open = signal(false);
  useOverlayOpen(() => open(), "device tool versions");
  const trigger = () => deviceToolTrigger(props.tools, props.kind, props.error);
  const row = (term: string, value: string) => (
    <View class="flex-row items-start justify-between gap-6">
      <Text class="text-xs text-muted-foreground">{term}</Text>
      <Text class="min-w-0 flex-1 text-right font-mono text-xs text-popover-foreground">{value}</Text>
    </View>
  );
  return (
    <Popover
      open={open()}
      onOpenChange={trackOpenChange(open)}
      placement="bottom"
      align="end"
      offset={6}
      popupClass="w-80 rounded-lg border border-border bg-popover-84 p-4"
      trigger={<View role="button" accessibilityLabel={trigger().label ?? trigger().text} class="rounded-sm hover:bg-accent"><Text class="text-xs font-medium text-muted-foreground">{trigger().text}</Text></View>}
    >
      <View>
        <Text class="text-sm font-semibold text-popover-foreground">{props.kind ? deviceToolName(props.kind) : "Device tools"}</Text>
        {props.tools ? (
          <View class="mt-4">
            {deviceToolRows(props.tools, props.kind).map(([name, running, required, installed], i) => (
              <View class={`gap-2 ${i > 0 ? "border-t border-border-60 pt-3" : ""} ${i < deviceToolRows(props.tools!, props.kind).length - 1 ? "pb-3" : ""}`}>
                {!props.kind ? <Text class="text-xs font-medium text-popover-foreground">{name}</Text> : null}
                <View class="gap-1">{row("Running", running)}{row("Required", required)}{row("Installed", installed)}</View>
              </View>
            ))}
          </View>
        ) : (
          <Text class="mt-3 text-xs text-muted-foreground">Versions have not been checked.</Text>
        )}
        <Text class="mt-4 border-t border-border-60 pt-3 text-xs text-muted-foreground">{deviceToolFooter(props.owner)}</Text>
        {props.error ? <Text role="alert" class="mt-2 text-xs text-destructive">{props.error}</Text> : null}
        {props.action ? <View class="mt-3">{props.action}</View> : null}
      </View>
    </Popover>
  );
}
