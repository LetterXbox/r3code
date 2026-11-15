// The administrator's policy as the server reports it (packages/contracts managedPolicy.ts) and the
// helpers state/managedPolicy.ts builds on it. Pure: no signals, so the panel and tests share it.
import { rec } from "./logic";

export interface ManagedPolicySummary {
  organization: string;
  supportUrl?: string;
  lockedSettings: string[];
  limits?: {
    providers?: { allowedDrivers?: string[]; lockedInstanceFields?: Record<string, string[]> };
    updates?: { mode?: string };
  };
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
}

/** `config.managedPolicy` from a server config, or undefined when the environment is unmanaged. */
export function parseManagedPolicy(value: unknown): ManagedPolicySummary | undefined {
  const policy = rec(value);
  if (!policy || typeof policy.organization !== "string" || policy.organization.trim() === "") return undefined;
  const limits = rec(policy.limits);
  const providers = rec(limits?.providers);
  const locked: Record<string, string[]> = {};
  for (const [driver, paths] of Object.entries(rec(providers?.lockedInstanceFields) ?? {})) locked[driver] = strings(paths) ?? [];
  const allowed = strings(providers?.allowedDrivers);
  const updates = rec(limits?.updates);
  return {
    organization: policy.organization,
    ...(typeof policy.supportUrl === "string" && policy.supportUrl ? { supportUrl: policy.supportUrl } : {}),
    lockedSettings: strings(policy.lockedSettings) ?? [],
    ...(limits ? { limits: {
      ...(providers ? { providers: { ...(allowed ? { allowedDrivers: allowed } : {}), lockedInstanceFields: locked } } : {}),
      ...(updates && typeof updates.mode === "string" ? { updates: { mode: updates.mode } } : {}),
    } } : {}),
  };
}

export interface ManagedInstanceLocks {
  configKeys: ReadonlySet<string>;
  environmentNames: ReadonlySet<string>;
  wholeEnvironment: boolean;
  reason: string;
}

/** What the policy pins on instances of `driver`, or undefined when nothing is. */
export function managedInstanceLocks(policy: ManagedPolicySummary | undefined, driver: string): ManagedInstanceLocks | undefined {
  const paths = policy?.limits?.providers?.lockedInstanceFields?.[driver];
  if (policy === undefined || paths === undefined || paths.length === 0) return undefined;
  const under = (prefix: string) => new Set(paths.flatMap((path) => path.startsWith(prefix) ? [path.slice(prefix.length)] : []));
  return { configKeys: under("config."), environmentNames: under("environment."), wholeEnvironment: paths.includes("environment"), reason: `Managed by ${policy.organization}.` };
}

/** Whether the policy lets `driver` run; absent allow-list means every driver. */
export function isManagedDriverAllowed(policy: ManagedPolicySummary | undefined, driver: string): boolean {
  const allowed = policy?.limits?.providers?.allowedDrivers;
  return allowed === undefined || allowed.includes(driver);
}

/** disallowedProviderMessage from contracts settings.ts. */
export function disallowedProviderMessage(organization: string | undefined, label: string): string {
  return `${organization === undefined ? "Your organization" : `${organization}'s`} policy does not allow the ${label} provider.`;
}

/** The text generators the server drops under a provider allow-list are hidden (ProviderSettingsPanel). */
export function showTextGenerators(policy: ManagedPolicySummary | undefined): boolean {
  return policy?.limits?.providers?.allowedDrivers === undefined;
}
