// The body of the "Use T3 Code in another app (MCP)" dialog (components/mcp/UseInAnotherAppDialog.tsx
// `Wizard`, `GateScreen`, `AppStep`, `ConnectStep`, `ApprovalCode`): the App / Access / Connect steps, and
// the gate screens that stand in front of them. It is controlled: the owner gives it the resolved gate
// (mcpGate.ts), which access levels may be granted, and a way to mint an approval code. The owner is
// UseInAnotherAppDialog.tsx, which mounts it whenever the build carries T3 Connect (cloud/publicConfig.ts).
import { Clipboard, openUrl, signal, Text, View } from "nsh";
import { Image } from "nsh";
import { SettingsButton } from "../SettingsLayout";
import { SettingsIcon } from "../../pages/settings/SettingsIcon";
import { showToast } from "../toast";
import { MCP_APPS, mcpHandoffAction, OTHER_MCP_APP_STEPS, type McpApp } from "./mcpApps";
import type { McpGate } from "./mcpGate";

export const MCP_ACCESS_LEVELS = ["read-only", "approval-required", "auto-accept-edits", "auto", "full-access"] as const;
export type McpClientAccess = (typeof MCP_ACCESS_LEVELS)[number];

/** accessConfig (auth/ConnectAgentSurface.tsx) over runtimeModeConfig. */
export const MCP_ACCESS_CONFIG: Record<McpClientAccess, { label: string; description: string }> = {
  "read-only": { label: "Read only", description: "Read projects and threads. Cannot start, message or change anything." },
  "approval-required": { label: "Supervised", description: "Ask before commands and file changes." },
  "auto-accept-edits": { label: "Auto-accept edits", description: "Auto-approve edits, ask before other actions." },
  auto: { label: "Auto", description: "Supported providers approve routine actions; others still ask." },
  "full-access": { label: "Full access", description: "Allow commands and edits without prompts." },
};

/** The level the Access step starts at: Auto, else the next one down that can be granted. */
export const DEFAULT_MCP_LEVELS: readonly McpClientAccess[] = ["auto", "auto-accept-edits", "approval-required", "read-only"];

export const MCP_WIZARD_STEPS = ["App", "Access", "Connect"] as const;
export type McpWizardStep = 0 | 1 | 2;
export type McpChoice = McpApp | "other";

/** What the gate screens ask of their owner. */
export interface McpGateActions {
  signIn: () => void;
  checkAgain: () => void;
  refreshList: () => void;
  turnOn: () => void;
  connecting: boolean;
  operationError: string | null;
  tunnelLimit: boolean;
  /** Where T3 Connect can be turned on: from here, only by policy (a reason), or on the host. */
  turnOnHere: { kind: "here" } | { kind: "policy"; reason: string } | { kind: "on-host" };
  manageAccess: () => void;
}

function GateMessage(props: { title: string; lines?: readonly string[]; children?: any }) {
  return (
    <View class="gap-3" accessibilityLabel={props.title}>
      <Text class="text-base font-medium text-foreground">{props.title}</Text>
      {props.lines && props.lines.length > 0 ? (
        <View class="gap-1">{props.lines.map((line) => <Text class="text-sm text-muted-foreground">{line}</Text>)}</View>
      ) : null}
      {props.children ?? null}
    </View>
  );
}

/** GateScreen: what each closed gate says, with the actions it offers. */
export function McpGateScreen(props: { name: string; gate: McpGate; actions: McpGateActions }) {
  // A component body runs once: the gate is read inside the child expression, so a new gate redraws it.
  return <View>{renderGate(props)}</View>;
}

function renderGate(props: { name: string; gate: McpGate; actions: McpGateActions }) {
  const { name, gate, actions } = props;
  const again = <SettingsButton label="Check again" onPress={actions.checkAgain} />;
  switch (gate.kind) {
    case "checking":
      return <Text class="text-sm text-muted-foreground">Checking T3 Connect…</Text>;
    case "sign-in":
      return (
        <GateMessage title="Sign in to T3 Connect" lines={[`Apps like Poke and Claude run in the cloud. They need a public address to reach ${name}.`, `T3 Connect gives ${name} that address. Each app still needs your approval.`]}>
          <SettingsButton label="Sign in to T3 Connect" tone="primary" onPress={actions.signIn} />
        </GateMessage>
      );
    case "disconnected":
      return gate.relay === null ? (
        <GateMessage title={`Connect to ${name} first.`} />
      ) : (
        <GateMessage title={gate.relay === "offline" ? `${name}'s T3 Connect is offline` : `Can't check T3 Connect on ${name}`}>
          <SettingsButton label="Check again" onPress={actions.refreshList} />
        </GateMessage>
      );
    case "update":
      return <GateMessage title={`Update R3 Code on ${name}`} />;
    case "no-relay-read":
      return <GateMessage title={`Can't check T3 Connect on ${name}`} lines={[`This device needs the View relay permission on ${name}.`]} />;
    case "error":
      return <GateMessage title={`Can't check T3 Connect on ${name}`} lines={[gate.message]}>{again}</GateMessage>;
    case "turn-on":
    case "offline": {
      if (gate.kind === "offline" && !actions.connecting) {
        const reachability = gate.reachability;
        return (
          <GateMessage
            title={reachability ? `${name}'s T3 Connect is offline` : `Can't check T3 Connect on ${name}`}
            lines={reachability ? [reachability.reason, `Fix: ${reachability.fix}`] : []}
          >
            {again}
          </GateMessage>
        );
      }
      return (
        <GateMessage title={`Turn on T3 Connect for ${name}`} lines={[`${name} gets a public https address, with no router setup.`, "Only apps you approve can use it. You can turn it off in Settings."]}>
          {actions.turnOnHere.kind === "here" ? (
            <View class="gap-2">
              <SettingsButton label={actions.connecting ? "Connecting…" : "Turn on"} tone="primary" disabled={actions.connecting} onPress={actions.turnOn} />
              {actions.operationError ? <Text class="text-xs text-destructive-foreground">{actions.operationError}</Text> : null}
              {actions.tunnelLimit ? (
                <>
                  <Text class="text-sm text-destructive-foreground">Your T3 Connect account is out of tunnels.</Text>
                  <SettingsButton label="Manage tunnels" onPress={actions.manageAccess} />
                </>
              ) : null}
            </View>
          ) : actions.turnOnHere.kind === "policy" ? (
            <Text class="text-sm text-muted-foreground">{actions.turnOnHere.reason}</Text>
          ) : (
            <View class="gap-2">
              <CopyRow label="Command" value="t3 connect link" />
              <Text class="text-sm text-foreground">{`Restart R3 Code on ${name}.`}</Text>
              {again}
            </View>
          )}
        </GateMessage>
      );
    }
    case "open":
      return null;
  }
}

function CopyRow(props: { label: string; value: string }) {
  const copied = signal(false);
  return (
    <View class="min-w-0 flex-row items-center gap-2 rounded-lg border border-border bg-muted-50 px-3 py-2">
      <Text class="shrink-0 text-xs text-muted-foreground">{props.label}</Text>
      <Text class="min-w-0 flex-1 truncate text-sm text-foreground">{props.value}</Text>
      <View
        role="button"
        accessibilityLabel={`Copy ${props.label}`}
        onPress={() => { void Clipboard.writeText(props.value).then(() => { copied.set(true); setTimeout(() => copied.set(false), 1500); }); }}
        class="size-6 items-center justify-center rounded-md hover:bg-accent"
      >
        <SettingsIcon name={copied() ? "check" : "copy"} size={14} />
      </View>
    </View>
  );
}

function TextButton(props: { label: string; onPress: () => void }) {
  return (
    <View role="button" accessibilityLabel={props.label} onPress={props.onPress} class="self-start">
      <Text class="text-sm font-medium text-foreground underline">{props.label}</Text>
    </View>
  );
}

function openLink(url: string) {
  void openUrl(url).catch((error: unknown) => showToast({ type: "error", title: "Could not open the link", description: error instanceof Error ? error.message : url }));
}

export function McpAppStep(props: { choice: McpChoice | null; onChoose: (choice: McpChoice) => void }) {
  return (
    <View class="gap-3">
      <Text class="text-sm font-medium text-foreground">Which app?</Text>
      <View class="flex-row flex-wrap gap-2">
        {MCP_APPS.filter((app) => !app.hidden).map((app) => (
          <View
            role="button"
            accessibilityLabel={app.name}
            onPress={() => props.onChoose(app)}
            class={`w-[23%] items-center gap-2 rounded-lg border px-1 py-3 hover:bg-accent ${props.choice === app ? "border-primary bg-accent-50" : "border-transparent"}`}
          >
            <Image src={app.logo} style={{ width: 40, height: 40, borderRadius: 8 }} />
            <Text class="max-w-full truncate text-xs font-medium text-foreground">{app.name}</Text>
          </View>
        ))}
      </View>
      <View
        role="button"
        accessibilityLabel="Something else…"
        onPress={() => props.onChoose("other")}
        class={`w-full rounded-lg border px-3 py-2.5 hover:bg-accent ${props.choice === "other" ? "border-primary bg-accent-50" : "border-border"}`}
      >
        <Text class="text-sm font-medium text-foreground">Something else…</Text>
      </View>
    </View>
  );
}

export function McpAccessStep(props: { appName: string; access: McpClientAccess | null; denials: ReadonlyMap<McpClientAccess, string>; onPick: (access: McpClientAccess) => void }) {
  return (
    <View class="gap-3">
      <Text class="text-sm font-medium text-foreground">{`What can ${props.appName} do?`}</Text>
      <View class="gap-2" role="group" accessibilityLabel={`What can ${props.appName} do?`}>
        {MCP_ACCESS_LEVELS.map((level) => {
          const denial = props.denials.get(level);
          const detail = denial ?? (level === "full-access" ? "Runs commands and edits files without asking" : MCP_ACCESS_CONFIG[level].description);
          return (
            <View
              role="button"
              accessibilityLabel={MCP_ACCESS_CONFIG[level].label}
              disabled={denial !== undefined}
              onPress={() => props.onPick(level)}
              class={`gap-0.5 rounded-lg border px-3 py-2.5 ${denial !== undefined ? "opacity-50" : "hover:bg-muted-50"} ${props.access === level ? "border-primary bg-background" : "border-border bg-background"}`}
            >
              <Text class="text-sm font-medium text-foreground">{MCP_ACCESS_CONFIG[level].label}</Text>
              <Text class="text-xs text-muted-foreground">{detail}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** "Get code" mints on click; the code is never copied or sent anywhere by itself. */
export interface McpApprovalCode { credential: string; expiresAt: number }

export function McpApprovalCodeBlock(props: { environmentName: string; access: McpClientAccess; mint: (access: McpClientAccess) => Promise<McpApprovalCode>; now: () => number }) {
  const code = signal<McpApprovalCode | null>(null);
  const pending = signal(false);
  const error = signal<string | null>(null);
  const live = () => code() !== null && props.now() < code()!.expiresAt;
  const left = () => (code() === null ? 0 : Math.max(0, Math.floor((code()!.expiresAt - props.now()) / 1000)));
  const run = async () => {
    pending.set(true);
    error.set(null);
    try {
      code.set(await props.mint(props.access));
    } catch {
      error.set(`Could not get a code from ${props.environmentName}. Try again.`);
    } finally {
      pending.set(false);
    }
  };
  return (
    <View class="gap-1.5">
      <View class="flex-row flex-wrap items-center justify-between gap-2">
        <Text class="text-sm text-foreground">{`Code to approve ${MCP_ACCESS_CONFIG[props.access].label}`}</Text>
        {live() ? null : <SettingsButton label={pending() ? "Getting code…" : code() === null ? "Get code" : "New code"} disabled={pending()} onPress={() => void run()} />}
      </View>
      {code() !== null ? (
        live() ? (
          <>
            <CopyRow label="Code" value={code()!.credential} />
            <Text class="text-xs text-muted-foreground">{`Expires ${Math.floor(left() / 60)}:${String(left() % 60).padStart(2, "0")} · one use`}</Text>
          </>
        ) : (
          <Text class="text-xs text-muted-foreground">The code expired.</Text>
        )
      ) : null}
      {error() ? <Text class="text-xs text-destructive-foreground">{error()}</Text> : null}
    </View>
  );
}

function PrimaryAction(props: { app: McpApp; mcpUrl: string }) {
  const action = mcpHandoffAction(props.app, props.mcpUrl);
  const note = props.app.note ? <Text class="text-xs text-muted-foreground">{props.app.note}</Text> : null;
  if (action === null) {
    return (
      <View class="gap-2">
        {props.app.handoff.kind === "commands" ? props.app.handoff.commands(props.mcpUrl).map((command) => <CopyRow label="Command" value={command} />) : null}
        <Text class="text-xs text-muted-foreground">{`Run these where ${props.app.name} runs.`}</Text>
        {note}
      </View>
    );
  }
  const handOff = async () => {
    if (action.copy !== null) {
      // The app opens only once the copy lands, so it never gets an older clipboard.
      try {
        await Clipboard.writeText(action.copy.text);
      } catch {
        showToast({ type: "error", title: "Could not copy", description: "Use Set up another way." });
        return;
      }
      showToast({ type: "success", title: action.copy.title });
    }
    openLink(action.link);
  };
  return (
    <View class="gap-2">
      <SettingsButton label={action.label} tone="primary" onPress={() => void handOff()} />
      {note}
    </View>
  );
}

export function McpConnectStep(props: { environmentName: string; mcpUrl: string; choice: McpChoice; access: McpClientAccess; mint: (access: McpClientAccess) => Promise<McpApprovalCode>; now: () => number; linked?: string | null }) {
  const anotherWay = signal(props.choice === "other");
  const app = props.choice === "other" ? null : props.choice;
  const code = <McpApprovalCodeBlock environmentName={props.environmentName} access={props.access} mint={props.mint} now={props.now} />;
  const linked = props.linked ? <Text class="text-xs text-muted-foreground">{`Linked: ${props.linked}`}</Text> : null;
  return (
    <View class="gap-4">
      {anotherWay() || app === null ? (
        <>
          <CopyRow label="URL" value={props.mcpUrl} />
          {app?.handoff.kind === "copy-message" ? <CopyRow label="Message" value={app.handoff.message(props.mcpUrl)} /> : null}
          <View class="gap-1">
            {(app?.steps ?? OTHER_MCP_APP_STEPS).map((step, index) => <Text class="text-sm text-foreground">{`${index + 1}. ${step}`}</Text>)}
          </View>
          {app === null ? (
            <Text class="text-xs text-muted-foreground">Apps that require their own client ID cannot connect.</Text>
          ) : app.docs ? (
            <TextButton label={`${app.name} help`} onPress={() => openLink(app.docs ?? "")} />
          ) : null}
          {code}
          {app === null ? null : <TextButton label={app.handoff.kind === "commands" ? "Back to commands" : "Back to one click"} onPress={() => anotherWay.set(false)} />}
          {linked}
        </>
      ) : (
        <>
          <PrimaryAction app={app} mcpUrl={props.mcpUrl} />
          <CopyRow label="URL" value={props.mcpUrl} />
          {code}
          <TextButton label="Set up another way" onPress={() => anotherWay.set(true)} />
          {linked}
        </>
      )}
    </View>
  );
}
