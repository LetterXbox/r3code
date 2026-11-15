// Lucide marks the diagnostics page draws (ResourceTelemetryDiagnostics.tsx, DiagnosticsSettings.tsx), as SVG
// files painted through <Image>. Marks the shared set already has (copy, triangle-alert, chevrons) come from there.
import { Image } from "nsh";
import { SettingsIcon } from "./SettingsIcon";
import activity from "./diagnosticsIcons/activity.svg";
import battery from "./diagnosticsIcons/battery.svg";
import cpu from "./diagnosticsIcons/cpu.svg";
import database from "./diagnosticsIcons/database.svg";
import folderOpen from "./diagnosticsIcons/folder-open.svg";
import gauge from "./diagnosticsIcons/gauge.svg";
import hardDrive from "./diagnosticsIcons/hard-drive.svg";
import memoryStick from "./diagnosticsIcons/memory-stick.svg";
import refreshCw from "./diagnosticsIcons/refresh-cw.svg";

const OWN: Record<string, typeof activity> = {
  activity, battery, cpu, database, "folder-open": folderOpen, gauge, "hard-drive": hardDrive, "memory-stick": memoryStick, "refresh-cw": refreshCw,
};

export function DiagnosticsIcon(props: { name: string; size?: number; tint?: string }) {
  const size = props.size ?? 16;
  const src = OWN[props.name];
  if (!src) return <SettingsIcon name={props.name} size={size} {...(props.tint ? { tint: props.tint } : {})} />;
  return <Image src={src} style={props.tint ? { width: size, height: size, tintColor: props.tint } : { width: size, height: size }} />;
}
