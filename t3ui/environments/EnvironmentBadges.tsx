// ProjectEnvironmentBadge (apps/web/src/components/ProjectEnvironmentBadge.tsx) for the port's one-project-per-row
// lists: a project of a saved environment shows that machine's icon, "On <label>" as its name and tooltip.
import { token, View } from "nsh";
import { Glyph } from "../components/sidebar/SidebarGlyph";
import { Tip } from "../components/sidebar/Tip";
import { machineKindForUrl } from "../components/thread/environmentOptions";
import { managedEnvironment } from "./connectionManager";

export function environmentLabelFor(environmentId: string | undefined): string | null {
  if (!environmentId) return null;
  return managedEnvironment(environmentId)?.label ?? "Remote";
}

export function projectEnvironmentDescription(environmentId: string | undefined): string | null {
  const label = environmentLabelFor(environmentId);
  return label ? `On ${label}` : null;
}

export function ProjectEnvironmentBadge(props: { environmentId: string | undefined }) {
  const description = projectEnvironmentDescription(props.environmentId);
  if (!description) return null;
  const machine = machineKindForUrl(managedEnvironment(props.environmentId!)?.url ?? null);
  return (
    <View accessibilityLabel={description} tooltip={<Tip label={description} />} class="items-center justify-center">
      <Glyph name={machine === "laptop" ? "laptop" : "server"} size={14} tint={token("muted-foreground")} />
    </View>
  );
}

/** ProjectEnvironmentBadge for a logical project group: the first remote member's machine icon with "On" / "Also on <labels>". */
export function ProjectGroupEnvironmentBadge(props: { description: string; environmentId: string }) {
  const machine = machineKindForUrl(managedEnvironment(props.environmentId)?.url ?? null);
  return (
    <View accessibilityLabel={props.description} tooltip={<Tip label={props.description} />} class="shrink-0 items-center justify-center">
      <Glyph name={machine === "laptop" ? "laptop" : "server"} size={14} tint={token("muted-foreground")} />
    </View>
  );
}
