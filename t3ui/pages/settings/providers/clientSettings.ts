// The client settings the web keeps per device (hooks/useSettings.ts useClientSettings) that the Providers area needs:
// the load-balancing switch and its per-machine weights. Kept in the app's own Storage, hydrated once, written on change.
import { signal, Storage } from "nsh";

export interface ClientSettings { loadBalancingEnabled: boolean; loadBalancingWeights: Record<string, number> }

const KEY = "clientSettings";
const defaults: ClientSettings = { loadBalancingEnabled: false, loadBalancingWeights: {} };
const current = signal<ClientSettings>(defaults);
const hydrated = signal(false);
let started = false;

/** Reads a stored copy, keeping only what the settings schema allows (LoadBalancingWeights: ints 0 to 100). */
export function parseClientSettings(raw: string | null | undefined): ClientSettings {
  if (!raw) return defaults;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const weights: Record<string, number> = {};
    const stored = value.loadBalancingWeights;
    if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
      for (const [id, weight] of Object.entries(stored)) {
        if (id.trim() !== "" && typeof weight === "number" && Number.isInteger(weight) && weight >= 0 && weight <= 100) weights[id] = weight;
      }
    }
    return { loadBalancingEnabled: value.loadBalancingEnabled === true, loadBalancingWeights: weights };
  } catch { return defaults; }
}

function hydrate(): void {
  if (started) return;
  started = true;
  void Storage.getItem(KEY).then((raw) => {
    // A write made before the read landed wins over the stored copy.
    if (!hydrated()) current.set(parseClientSettings(raw));
  }).catch(() => {}).finally(() => hydrated.set(true));
}

export function clientSettings(): ClientSettings { hydrate(); return current(); }
export function clientSettingsHydrated(): boolean { hydrate(); return hydrated(); }
export function updateClientSettings(patch: Partial<ClientSettings>): void {
  hydrated.set(true);
  current.update((all) => ({ ...all, ...patch }));
  void Storage.setItem(KEY, JSON.stringify(current())).catch(() => {});
}
/** Tests start from a clean copy. */
export function resetClientSettings(): void { current.set(defaults); hydrated.set(false); started = false; }
