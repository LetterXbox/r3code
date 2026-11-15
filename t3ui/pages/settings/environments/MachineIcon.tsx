// EnvironmentMachineIcon.tsx: the mark of a machine kind (`ENVIRONMENT_MACHINE_KINDS`,
// packages/contracts/src/environment.ts), its label, and the kind an environment resolves to
// (`resolveEnvironmentMachineKind`: the user's pick, else what the server detected, else "server").
import { Image } from "nsh";
import cloud from "../../../icons/cloud.svg";
import laptop from "../../../icons/laptop.svg";
import linux from "../../../icons/linux.svg";
import macMini from "../../../icons/mac-mini.svg";
import macStudio from "../../../icons/mac-studio.svg";
import monitor from "../../../icons/monitor.svg";
import server from "../../../icons/server.svg";

export const ENVIRONMENT_MACHINE_KINDS = ["server", "cloud", "linux", "desktop", "laptop", "mac-mini", "mac-studio"] as const;
export type EnvironmentMachineKind = (typeof ENVIRONMENT_MACHINE_KINDS)[number];

export const ENVIRONMENT_MACHINE_KIND_LABELS: Record<EnvironmentMachineKind, string> = {
  server: "Server",
  cloud: "Cloud VM",
  linux: "Linux/WSL",
  desktop: "Desktop",
  laptop: "Laptop",
  "mac-mini": "Mini PC",
  "mac-studio": "Workstation",
};

const ICON_BY_KIND: Record<EnvironmentMachineKind, typeof server> = {
  server, cloud, linux, desktop: monitor, laptop, "mac-mini": macMini, "mac-studio": macStudio,
};

export const isEnvironmentMachineKind = (value: unknown): value is EnvironmentMachineKind =>
  typeof value === "string" && (ENVIRONMENT_MACHINE_KINDS as readonly string[]).includes(value);

/** resolveEnvironmentMachineKind over the server's config: `settings.environmentIcon`, else `environment.platform.machine`, else "server". */
export function resolveEnvironmentMachineKind(config: { environment?: { platform?: { machine?: unknown } } | null; settings?: { environmentIcon?: unknown } | null } | null): EnvironmentMachineKind {
  const picked = config?.settings?.environmentIcon;
  if (isEnvironmentMachineKind(picked)) return picked;
  const detected = config?.environment?.platform?.machine;
  return isEnvironmentMachineKind(detected) ? detected : "server";
}

export function MachineIcon(props: { kind: EnvironmentMachineKind; size?: number; tint?: string }) {
  const size = props.size ?? 16;
  return <Image src={ICON_BY_KIND[props.kind]} style={props.tint ? { width: size, height: size, tintColor: props.tint } : { width: size, height: size }} />;
}
