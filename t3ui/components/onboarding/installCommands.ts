// onboarding/providerReadiness.logic.ts: the commands the in-page terminal types for an agent that needs installing or signing in.
const SAFE_SHELL_BINARY = /^[A-Za-z0-9_./:\\-]+$/;

export type PlatformOs = "darwin" | "linux" | "windows" | string;

export function quoteProviderBinary(binaryPath: string, fallback: string, platform: PlatformOs): string {
  if (SAFE_SHELL_BINARY.test(binaryPath) && (platform === "windows" || !binaryPath.includes("\\"))) return binaryPath;
  if (platform === "windows") return `& '${binaryPath.replaceAll("'", "''")}'`;
  if (platform === "darwin" || platform === "linux") {
    if (binaryPath.startsWith("~/") || binaryPath.startsWith("~\\")) return `~/'${binaryPath.slice(2).replaceAll("'", `'"'"'`)}'`;
    return `'${binaryPath.replaceAll("'", `'"'"'`)}'`;
  }
  return fallback;
}

const NATIVE_INSTALL_COMMANDS = {
  claudeAgent: { windows: "irm https://claude.ai/install.ps1 | iex", posix: "curl -fsSL https://claude.ai/install.sh | bash" },
  codex: { windows: "irm https://chatgpt.com/codex/install.ps1 | iex", posix: "curl -fsSL https://chatgpt.com/codex/install.sh | sh" },
} as const;

export function resolveOnboardingProviderInstallCommand(driver: keyof typeof NATIVE_INSTALL_COMMANDS, platform: PlatformOs): string {
  const commands = NATIVE_INSTALL_COMMANDS[driver];
  return platform === "windows" ? commands.windows : commands.posix;
}

type Settings = { providerInstances?: Record<string, { config?: { binaryPath?: unknown } } | undefined> } | null | undefined;

/** `claude auth login` / `codex login`, with the binary path the instance is configured with. */
export function resolveOnboardingProviderLoginCommand(provider: { instanceId: string; driver: string }, settings: Settings, platform: PlatformOs): string {
  const configured = settings?.providerInstances?.[provider.instanceId]?.config?.binaryPath;
  const binary = typeof configured === "string" && configured.trim() ? configured : provider.driver === "claudeAgent" ? "claude" : "codex";
  if (provider.driver === "claudeAgent") return `${quoteProviderBinary(binary, "claude", platform)} auth login`;
  if (provider.driver === "codex") return `${quoteProviderBinary(binary, "codex", platform)} login`;
  return provider.driver;
}

/** What the terminal header says (AgentInstallTerminal). */
export type InstallTerminalState = "preparing" | "ready" | "openFailed";
export function installTerminalNote(state: InstallTerminalState, canOperate: boolean): string {
  if (!canOperate) return "This connection cannot control terminals.";
  return state === "ready" ? "Review the command, then press Enter to run it." : state === "openFailed" ? "Could not open the setup terminal." : "Preparing command...";
}
