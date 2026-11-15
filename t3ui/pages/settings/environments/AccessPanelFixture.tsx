import { mount, signal, Text, View } from "nsh";
import { configureBackend } from "../../../store";
import { AccessSettings } from "./AccessPanel";
import { accessSession } from "./accessSession";
import { accessState, createdCredentials } from "./accessClients";
import { observeServerConfigEvent } from "../settingsState";

configureBackend("ws://10.0.0.9:3773/ws");
const policy = signal("loopback-browser");
const all = ["orchestration:read", "orchestration:operate", "settings:write", "providers:manage", "environment:maintain", "preview:operate", "diagnostics:read", "terminal:read", "terminal:operate", "source-control:write", "filesystem:read", "filesystem:write", "access:read", "access:write", "relay:read", "relay:write"];
accessSession.set({ status: "ready", authenticated: true, policy: policy(), scopes: all });
observeServerConfigEvent({ type: "snapshot", config: { settings: {}, keybindings: [], environment: { label: "Studio Mac", serverVersion: "1.2.3", platform: { os: "darwin", arch: "arm64", machine: "mac-mini" } }, managedPolicy: null } });
accessState.set({
  loaded: true, error: null,
  pairingLinks: [{ id: "l1", label: "iPad", scopes: ["orchestration:read"], createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }],
  clientSessions: [],
});
createdCredentials.set({ l1: "CODE1" });

mount(() => (
  <View class="flex-1 gap-3">
    <View accessibilityLabel="Policy remote" onPress={() => accessSession.update((s) => ({ ...s, policy: "remote-reachable" }))}><Text>Policy remote</Text></View>
    <View accessibilityLabel="Policy unknown" onPress={() => accessSession.update((s) => ({ ...s, policy: "desktop-managed-local" }))}><Text>Policy unknown</Text></View>
    <View accessibilityLabel="Session write only" onPress={() => accessSession.update((s) => ({ ...s, scopes: ["orchestration:read", "access:write"] }))}><Text>Session write only</Text></View>
    <View accessibilityLabel="Session none" onPress={() => accessSession.update((s) => ({ ...s, scopes: ["orchestration:read"] }))}><Text>Session none</Text></View>
    <AccessSettings />
  </View>
));
