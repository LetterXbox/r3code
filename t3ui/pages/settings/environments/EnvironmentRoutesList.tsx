// EnvironmentRoutesList.tsx: a saved environment's routes, preferred first, under its row while "Routes" is open. The
// grip reorders by dragging (dnd-kit there, a pan here); a route other than the last can be removed after confirming;
// "Add route" pairs the machine over another address. Learned routes (found automatically) are not kept by this port.
import { signal, Text, token, View } from "nsh";
import { confirm } from "../../../components/toast";
import { tokenAlpha } from "../../../components/composer/tokenColor";
import { SettingsIcon } from "../SettingsIcon";
import { environmentConnections } from "../../../environments/connectionManager";
import { environmentRoutes, reorderEnvironmentRoutes, removeEnvironmentRoute, savedEnvironments, type SavedEnvironment } from "./savedEnvironments";
import { moveRoute, routeAddress, routeLabel } from "./routeLabels";

const ROW_HEIGHT = 44;

export function EnvironmentRoutesList(props: { environment: SavedEnvironment; onAddRoute: () => void }) {
  const current = () => savedEnvironments().find((item) => item.id === props.environment.id) ?? props.environment;
  const routes = () => environmentRoutes(current());
  const inUse = () => (current().enabled && environmentConnections()[current().id]?.phase === "connected" ? current().url : null);
  const confirmRemove = async (url: string) => {
    const address = routeAddress(url);
    const confirmed = await confirm(`Remove ${routeLabel(url)} route?${address === null ? "" : `\n${address}`}`, { variant: "destructive" });
    if (confirmed !== true) return;
    await removeEnvironmentRoute(current().id, url);
  };
  return (
    <View class="mx-4 border-t border-border-50 py-2" accessibilityLabel={`Routes to ${current().label}, preferred first`}>
      <Each of={routes()} key={(url) => url}>
        {(url, index) => (
          <RouteRow
            url={url()}
            position={index() + 1}
            inUse={url() === inUse()}
            removable={routes().length > 1}
            onMove={(by) => { const from = index(); const to = Math.max(0, Math.min(routes().length - 1, from + by)); if (to !== from) reorderEnvironmentRoutes(current().id, moveRoute(routes(), from, to)); }}
            onRemove={() => void confirmRemove(url())}
          />
        )}
      </Each>
      <View class="-ml-1.5 flex-row pt-1">
        <View role="button" accessibilityLabel="Add route" onPress={props.onAddRoute} class="h-6 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent">
          <SettingsIcon name="plus" size={12} />
          <Text class="text-xs font-medium text-muted-foreground">Add route</Text>
        </View>
      </View>
    </View>
  );
}

function RouteRow(props: { url: string; position: number; inUse: boolean; removable: boolean; onMove: (by: number) => void; onRemove: () => void }) {
  const label = routeLabel(props.url);
  const address = routeAddress(props.url);
  const dragging = signal(false);
  return (
    <View class={`flex-row items-center gap-2 py-2 ${dragging() ? "rounded-md bg-background" : ""}`} testID={`Route ${props.position} ${label}`}>
      <View class="min-w-0 flex-1">
        <View class="flex-row items-center gap-1.5">
          <Text class="text-xs font-medium text-foreground">{label}</Text>
          {props.inUse ? <View class="rounded-sm px-1" style={{ backgroundColor: tokenAlpha("success", 0.12) }}><Text class="text-2xs text-success-foreground">In use</Text></View> : null}
        </View>
        {address !== null ? <Text class="truncate text-2xs text-muted-foreground">{address}</Text> : null}
      </View>
      <View
        role="button"
        accessibilityLabel={`Reorder ${label}, position ${props.position}`}
        onPanStart={() => dragging.set(true)}
        onPanEnd={(event) => { dragging.set(false); if (!event.cancelled) props.onMove(Math.round(event.translation.y / ROW_HEIGHT)); }}
        class="size-6 shrink-0 items-center justify-center rounded"
      >
        <SettingsIcon name="grip-vertical" size={14} tint={token("muted-foreground")} />
      </View>
      {props.removable ? (
        <View role="button" accessibilityLabel={`Remove ${label} route`} tooltip="Remove route" onPress={props.onRemove} class="size-6 items-center justify-center rounded-md hover:bg-accent">
          <SettingsIcon name="x" size={12} />
        </View>
      ) : null}
    </View>
  );
}
