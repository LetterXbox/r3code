// Reading and writing each environment's model prices (UsagePriceOverrides.tsx's priceTargetsAtom and writeUsagePrices): the
// live connection through the store, every saved environment through its own one-shot session (requestUsageEnvironment).
import { fetchSessionGrant, parseSessionGrant, sessionGrantsScope } from "../../backend/providers";
import { loadSessionBearer } from "../../backend/sessionCredential";
import { replaceServerSettings, serverEnvironment, serverSettings } from "../../pages/settings/settingsState";
import { savedUsageEnvironments, primaryUsageUrl, requestUsageEnvironment } from "./usageEnvironments";
import { backendBearer, backendUrl } from "../../store";
import type { UsagePrice, UsagePriceTarget } from "./usageSelection";
import type { UsageEnvironmentEntry } from "./usageSelection";

type Dict = Record<string, unknown>;
const dict = (value: unknown): Dict | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dict) : null);

let accessOverride: ((id: string) => Promise<boolean>) | null = null;
/** Tests decide whether an environment lets this session change settings without an HTTP session behind it. */
export function setUsagePriceAccessForTest(read: ((id: string) => Promise<boolean>) | null) { accessOverride = read; }

/** Whether this session holds settings:write on the environment (sessionGrantsScope with AuthSettingsWriteScope). */
async function canWriteSettings(id: string): Promise<boolean> {
  if (accessOverride) return accessOverride(id);
  try {
    const saved = savedUsageEnvironments().find((environment) => environment.id === id);
    const url = saved ? saved.url : backendUrl();
    const bearer = saved ? await loadSessionBearer(saved.url) : backendBearer();
    if (!url || !bearer) return false;
    const grant = await fetchSessionGrant(url, bearer);
    return grant !== null && sessionGrantsScope(parseSessionGrant(grant) ?? { authenticated: false }, "settings:write");
  } catch { return false; }
}

function pricesOf(settings: Dict | null): Record<string, UsagePrice> | null {
  const value = settings ? dict(settings.usagePriceOverrides) : null;
  return value ? (value as Record<string, UsagePrice>) : settings ? {} : null;
}
/** Mappings need a server that reports `usageModelAliases`; an older one cannot hold them. */
function aliasesOf(settings: Dict | null, capabilities: Dict | null): Record<string, string> | null {
  if (!settings || capabilities?.usageModelAliases === false) return null;
  const value = dict(settings.usageModelAliases);
  return value ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
}

/** Every listed environment's prices, mappings and why it cannot be changed (Offline, Prices not loaded, Read-only access). */
export async function loadUsagePriceTargets(environments: readonly UsageEnvironmentEntry[]): Promise<UsagePriceTarget[]> {
  return Promise.all(environments.map(async (environment): Promise<UsagePriceTarget> => {
    if (!environment.connected) return { id: environment.id, label: environment.label, prices: null, aliases: null, unavailable: "Offline" };
    let settings: Dict | null = null; let capabilities: Dict | null = null;
    try {
      if (environment.id === primaryUsageUrl()) { settings = dict(serverSettings()); capabilities = dict(serverEnvironment()?.capabilities); }
      else {
        const config = dict(await requestUsageEnvironment(environment.id, "server.getConfig", {}, { timeoutMs: 30000 }));
        settings = dict(config?.settings); capabilities = dict(dict(config?.environment)?.capabilities);
      }
    } catch { settings = null; }
    if (settings === null) return { id: environment.id, label: environment.label, prices: null, aliases: null, unavailable: "Prices not loaded" };
    const writable = await canWriteSettings(environment.id);
    return { id: environment.id, label: environment.label, prices: pricesOf(settings), aliases: aliasesOf(settings, capabilities), unavailable: writable ? null : "Read-only access" };
  }));
}

/** `server.updateSettings` on one environment; the live connection also takes the settings it answers with. */
export async function writeUsagePriceSettings(environmentId: string, patch: Record<string, unknown>): Promise<void> {
  const saved = await requestUsageEnvironment(environmentId, "server.updateSettings", { patch }, { timeoutMs: 30000 });
  if (environmentId === primaryUsageUrl()) replaceServerSettings(saved);
}
