// WelcomePage's AgentInstallTerminal: a terminal under the agent rows with the install or sign-in command typed in and not run, so the
// user reviews it and presses Enter. The terminal is a real server PTY (`terminal.attach`) in the server's own folder.
import { signal, Text, View } from "nsh";
import { TerminalPane } from "../terminal/TerminalPanel";
import { queueTerminalInput } from "../terminal/pendingInput";
import { requestBackend } from "../../store";
import { serverEnvironment, serverSettings } from "../../pages/settings/settingsState";
import { serverWelcome } from "../coordinators/serverStreams";
import { installTerminalNote, resolveOnboardingProviderInstallCommand, resolveOnboardingProviderLoginCommand } from "./installCommands";
import type { WelcomeProvider } from "./welcomePage.logic";

/** The thread id the web gives the setup terminals; no thread has it. */
export const AGENT_ONBOARDING_THREAD_ID = "onboarding-agent-setup";

export interface AgentTerminalSession { terminalId: string; instanceId: string; driver: string; name: string; cwd: string; command: string }

const session = signal<AgentTerminalSession | null>(null);
export const agentTerminalSession = () => session();

export function platformOs(): string {
  const os = (serverEnvironment() as { platform?: { os?: unknown } } | null)?.platform?.os;
  return typeof os === "string" ? os : "darwin";
}

/** Opens the terminal for `provider`: its login command once installed, else the native install command. Null when the server's folder is unknown. */
export function openAgentTerminal(provider: WelcomeProvider, cwd: string | null = serverWelcome()?.cwd ?? null): AgentTerminalSession | null {
  if ((provider.driver !== "claudeAgent" && provider.driver !== "codex") || !cwd) return null;
  const os = platformOs();
  const command = provider.installed
    ? resolveOnboardingProviderLoginCommand(provider, serverSettings() as never, os)
    : resolveOnboardingProviderInstallCommand(provider.driver, os);
  const next: AgentTerminalSession = { terminalId: `onboarding-${provider.driver}-${crypto.randomUUID()}`, instanceId: provider.instanceId, driver: provider.driver, name: provider.displayName, cwd, command };
  // Typed on attach, without Enter: the pane takes this queue when the PTY is running.
  queueTerminalInput(AGENT_ONBOARDING_THREAD_ID, next.terminalId, command);
  session.set(next);
  return next;
}

export function closeAgentTerminal() {
  const current = session();
  session.set(null);
  if (current) void requestBackend("terminal.close", { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId: current.terminalId, deleteHistory: true }).catch(() => undefined);
}

export function AgentInstallTerminal(props: { onClose: () => void }) {
  return (
    <View class="mt-4 overflow-hidden rounded-lg border border-border bg-background" accessibilityLabel="Agent setup terminal">
      <View class="flex-row items-center justify-between border-b border-border-60 px-3 py-1.5">
        <Text class="text-2xs font-medium text-muted-foreground">{installTerminalNote("ready", true)}</Text>
        <View role="button" accessibilityLabel="Close setup terminal" onPress={props.onClose} class="h-6 items-center justify-center rounded-md px-2 hover:bg-accent"><Text class="text-xs font-medium text-muted-foreground">Close</Text></View>
      </View>
      <View class="h-64">
        {session() ? <TerminalPane threadId={AGENT_ONBOARDING_THREAD_ID} terminalId={session()!.terminalId} cwd={session()!.cwd} active /> : null}
      </View>
    </View>
  );
}
