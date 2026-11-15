// Headless fixture: the remove-T3-Connect-environment dialog, opened and driven by the test through two buttons.
import { mount, signal, Text, View } from "nsh";
import { EMPTY_RELAY_DISCOVERY, relayDiscovery } from "./relayDiscovery";
import { pendingT3ConnectRemoval, RemoveT3ConnectEnvironmentDialog } from "./RemoveT3ConnectEnvironmentDialog";

const removed = signal("none");
const listed = (ids: string[]) => relayDiscovery.set({ ...EMPTY_RELAY_DISCOVERY, listed: true, environments: new Map(ids.map((id) => [id, {} as any])) });

mount(() => (
  <View class="flex-1 gap-2">
    <View accessibilityLabel="open-unknown" onPress={() => { relayDiscovery.set(EMPTY_RELAY_DISCOVERY); pendingT3ConnectRemoval.set({ id: "saved:1", label: "Studio Mac", relayEnvironmentId: "env-1" }); }}><Text>open-unknown</Text></View>
    <View accessibilityLabel="open-registered" onPress={() => { listed(["env-1"]); pendingT3ConnectRemoval.set({ id: "saved:1", label: "Studio Mac", relayEnvironmentId: "env-1" }); }}><Text>open-registered</Text></View>
    <View accessibilityLabel="open-unregistered" onPress={() => { listed([]); pendingT3ConnectRemoval.set({ id: "saved:1", label: "Studio Mac", relayEnvironmentId: "env-1" }); }}><Text>open-unregistered</Text></View>
    <Text>{`removed:${removed()}`}</Text>
    <RemoveT3ConnectEnvironmentDialog onConfirm={(target) => { removed.set(target.id); pendingT3ConnectRemoval.set(null); }} />
  </View>
));
