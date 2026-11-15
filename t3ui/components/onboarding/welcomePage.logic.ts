// onboarding/welcomePage.logic.ts and providerReadiness.logic.ts: which agents the Welcome page lists as found, which it offers
// to add, and the one action each row carries. Inputs are the server's own provider records (ServerProvider).
export interface WelcomeProvider {
  instanceId: string;
  driver: string;
  displayName: string;
  enabled: boolean;
  installed: boolean;
  status: string;
  availability: string | null;
  authStatus: string;
  message: string | null;
  unavailableReason: string | null;
  compatibilityStatus: string | null;
  canAuthenticate: boolean;
}

export type WelcomeAgentState = "checking" | "disabled" | "install" | "signIn" | "ready" | "attention";

type Dict = Record<string, unknown>;
const dict = (value: unknown): Dict | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dict) : null);
const text = (value: unknown) => (typeof value === "string" ? value : null);

/** The names the web's resolveProviderInstanceDisplayName falls back to: the display name, else the instance id. */
export function readWelcomeProvider(value: unknown): WelcomeProvider | null {
  const provider = dict(value);
  if (!provider || typeof provider.instanceId !== "string") return null;
  return {
    instanceId: provider.instanceId,
    driver: text(provider.driver) ?? provider.instanceId,
    displayName: text(provider.displayName)?.trim() || provider.instanceId,
    enabled: provider.enabled === true,
    installed: provider.installed === true,
    status: text(provider.status) ?? "unknown",
    availability: text(provider.availability),
    authStatus: text(dict(provider.auth)?.status) ?? "unknown",
    message: text(provider.message),
    unavailableReason: text(provider.unavailableReason),
    compatibilityStatus: text(dict(provider.compatibilityAdvisory)?.status),
    canAuthenticate: dict(provider.setup)?.canAuthenticate === true,
  };
}

/** getOnboardingProviderState. */
export function onboardingProviderState(provider: WelcomeProvider | undefined): WelcomeAgentState {
  if (provider === undefined) return "checking";
  if (!provider.enabled || provider.status === "disabled") return "disabled";
  if (!provider.installed && provider.status === "warning" && provider.authStatus === "unknown") return "checking";
  if (!provider.installed) return "install";
  if (provider.authStatus === "unauthenticated") return "signIn";
  if (provider.status === "ready") return "ready";
  return "attention";
}

/** The saved settings' `providerInstances`, as far as the page reads them. */
export type WelcomeSettings = { providerInstances?: Record<string, { enabled?: boolean } | undefined> } | null | undefined;

const ACP_REGISTRY_DRIVER = "acpRegistry";

/** An agent's state for new threads on this computer (welcomeAgentState). */
export function welcomeAgentState(provider: WelcomeProvider, settings: WelcomeSettings): WelcomeAgentState {
  if (provider.availability === "unavailable") return "attention";
  if (settings?.providerInstances?.[provider.instanceId]?.enabled === false) return "disabled";
  const state = onboardingProviderState(provider);
  if (state === "ready" && provider.compatibilityStatus === "broken") return "attention";
  return state === "checking" && provider.driver === ACP_REGISTRY_DRIVER ? "attention" : state;
}

const FOUND_ORDER = { ready: 0, signIn: 1, attention: 2 } as const;
type FoundState = keyof typeof FOUND_ORDER;
const isFoundState = (state: string): state is FoundState => state in FOUND_ORDER;

/** Splits a computer's allowed providers into agents already on it and agents the user can add (groupWelcomeAgents). */
export function groupWelcomeAgents(
  providers: ReadonlyArray<WelcomeProvider> | null | undefined,
  settings: WelcomeSettings,
  isAllowed: (provider: WelcomeProvider) => boolean = () => true,
) {
  const found: Array<{ provider: WelcomeProvider; state: FoundState }> = [];
  const available: WelcomeProvider[] = [];
  let checking = providers == null;
  let readyCount = 0;
  for (const provider of providers ?? []) {
    if (!isAllowed(provider)) continue;
    const state = welcomeAgentState(provider, settings);
    if (state === "ready") readyCount += 1;
    if (state === "checking") checking = true;
    if (isFoundState(state)) found.push({ provider, state });
    else available.push(provider);
  }
  const byName = (a: WelcomeProvider, b: WelcomeProvider) => a.displayName.localeCompare(b.displayName);
  found.sort((a, b) => FOUND_ORDER[a.state] - FOUND_ORDER[b.state] || byName(a.provider, b.provider));
  available.sort(byName);
  return { checking, readyCount, found: found.map((entry) => entry.provider), available };
}

/** A CLI the server knows is too old or otherwise broken for T3 Code; Settings updates it. */
export const isBrokenVersion = (provider: WelcomeProvider) => provider.installed && provider.compatibilityStatus === "broken";

/** Claude Code and Codex rows install or sign in through the page; every other agent goes through Settings. */
export const INSTALLABLE_DRIVERS = ["codex", "claudeAgent"] as const;
export const isInstallableDriver = (driver: string) => (INSTALLABLE_DRIVERS as readonly string[]).includes(driver);

/** Codex's row opens its setup card (ChatGPT sign-in or the CLI) unless it is signed in or broken. */
export function codexNeedsSetup(provider: WelcomeProvider, settings: WelcomeSettings): boolean {
  if (provider.driver !== "codex" || provider.authStatus === "authenticated" || isBrokenVersion(provider)) return false;
  const state = welcomeAgentState(provider, settings);
  return state === "install" || state === "signIn" || (state === "attention" && provider.availability !== "unavailable");
}

export type WelcomeAction = { kind: "turnOn" | "update" | "setUp" | "details" | "signIn"; label: string };

/** The one button a row carries (AgentsSection's actionFor), by label; the page decides where it leads. */
export function welcomeAgentAction(provider: WelcomeProvider, settings: WelcomeSettings): WelcomeAction | null {
  const state = welcomeAgentState(provider, settings);
  if (state === "ready" || state === "checking") return null;
  if (state === "disabled") return { kind: "turnOn", label: "Turn on" };
  if (isBrokenVersion(provider)) return { kind: "update", label: "Update" };
  if (provider.driver === "codex" && codexNeedsSetup(provider, settings)) return { kind: "setUp", label: "Set up" };
  if (isInstallableDriver(provider.driver) && (state === "install" || state === "signIn")) {
    return state === "signIn" ? { kind: "signIn", label: "Sign in" } : { kind: "setUp", label: "Install" };
  }
  return state === "signIn" ? { kind: "signIn", label: "Sign in" } : state === "attention" ? { kind: "details", label: "Details" } : { kind: "setUp", label: "Set up" };
}

/** AgentRow's detail line under a name: why an agent that is on is not ready. */
export function welcomeAgentDetail(provider: WelcomeProvider, state: WelcomeAgentState, compact: boolean, brokenMessage: string | null = null): string | null {
  if (state === "install") return isInstallableDriver(provider.driver) ? null : "Not installed";
  if (compact || state === "ready" || state === "checking") return null;
  if (state === "attention") return provider.unavailableReason ?? brokenMessage ?? provider.message;
  return brokenMessage ?? provider.message;
}

/** The label of the Start button (WelcomePage's footer), without a project import. */
export function startButtonLabel(starting: boolean): string {
  return starting ? "Starting…" : "Start";
}

/** AgentsSection notes: what this connection's scopes keep it from doing for the listed agents. acpAllowed (the ACP
 * registry driver allowed by policy) also raises the manage note in the reference. */
export function welcomeAgentNotes(input: {
  providers: readonly WelcomeProvider[]; settings: WelcomeSettings; canOperateTerminal: boolean; canManageProviders: boolean; acpAllowed?: boolean;
}): string[] {
  const state = (provider: WelcomeProvider) => welcomeAgentState(provider, input.settings);
  const needsInstallOrSignIn = (provider: WelcomeProvider) =>
    isInstallableDriver(provider.driver) && !isBrokenVersion(provider) && (state(provider) === "install" || state(provider) === "signIn");
  const notes: string[] = [];
  if (!input.canOperateTerminal && input.providers.some((provider) => needsInstallOrSignIn(provider) || codexNeedsSetup(provider, input.settings))) {
    notes.push("This connection cannot control terminals.");
  }
  if (!input.canManageProviders && (input.acpAllowed === true || input.providers.some((provider) => state(provider) === "disabled" || codexNeedsSetup(provider, input.settings)))) {
    notes.push("This connection cannot manage agents.");
  }
  return notes;
}
