import { mount, signal, Text, View } from "nsh";
import { MCP_APPS } from "./mcpApps";
import { McpAccessStep, McpAppStep, McpConnectStep, McpGateScreen, type McpChoice, type McpClientAccess } from "./McpWizard";
import type { McpGate } from "./mcpGate";

const gate = signal<McpGate>({ kind: "sign-in" });
const stage = signal<"gate" | "app" | "access" | "connect">("gate");
const choice = signal<McpChoice | null>(null);
const access = signal<McpClientAccess | null>("auto");
const log = signal<string[]>([]);
const say = (line: string) => log.update((all) => [...all, line]);
const actions = {
  signIn: () => say("sign in"), checkAgain: () => say("check again"), refreshList: () => say("refresh list"), turnOn: () => say("turn on"),
  connecting: false, operationError: null, tunnelLimit: false, turnOnHere: { kind: "here" as const }, manageAccess: () => say("manage"),
};
const denials = new Map<McpClientAccess, string>([["full-access", "This device cannot grant this on Studio."]]);
const gates: [string, McpGate][] = [
  ["g-checking", { kind: "checking" }], ["g-signin", { kind: "sign-in" }], ["g-disc", { kind: "disconnected", relay: null }],
  ["g-disc-off", { kind: "disconnected", relay: "offline" }], ["g-update", { kind: "update" }], ["g-norelay", { kind: "no-relay-read" }],
  ["g-error", { kind: "error", message: "Could not reach T3 Connect." }], ["g-turnon", { kind: "turn-on" }],
  ["g-offline", { kind: "offline", reachability: { status: "unreachable", checkedAt: "x", cause: "no_connector", reason: "No live connection.", hint: null, fix: "Restart T3 Code." } }],
];

mount(() => (
  <View class="flex-1 gap-2">
    {gates.map(([id, value]) => <View accessibilityLabel={id} onPress={() => { gate.set(value); stage.set("gate"); }}><Text>{id}</Text></View>)}
    <View accessibilityLabel="stage-app" onPress={() => stage.set("app")}><Text>stage-app</Text></View>
    <View accessibilityLabel="stage-access" onPress={() => stage.set("access")}><Text>stage-access</Text></View>
    <View accessibilityLabel="stage-connect" onPress={() => stage.set("connect")}><Text>stage-connect</Text></View>
    <Text>{`log ${log().join(",")}`}</Text>
    <Text>{`choice ${choice() === null ? "none" : choice() === "other" ? "other" : (choice() as { name: string }).name}`}</Text>
    {stage() === "gate" ? <McpGateScreen name="Studio" gate={gate()} actions={actions} /> : null}
    {stage() === "app" ? <McpAppStep choice={choice()} onChoose={(next) => choice.set(next)} /> : null}
    {stage() === "access" ? <McpAccessStep appName="Claude" access={access()} denials={denials} onPick={(level) => access.set(level)} /> : null}
    {stage() === "connect" ? <McpConnectStep environmentName="Studio" mcpUrl="https://prod.t3coderelay.com/mcp" choice={MCP_APPS[1]!} access="auto" mint={async () => ({ credential: "AUTO-ABCDEFGHJKLM", expiresAt: Date.now() + 120_000 })} now={() => Date.now()} /> : null}
  </View>
));
