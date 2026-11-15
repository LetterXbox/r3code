// What the connected server makes available to the settings search, `useAvailableSettingsSearchItems`.
//
// Imports nothing from store.ts (store.ts feeds this to the search). The native app has one
// connection, so each "any environment" test is a test of that one server's config snapshot.
// Flags the native build cannot honour are false, so the search never offers a setting that
// has nothing behind it: no T3 Connect cloud config, no WSL backend, no managed tunnel and
// no peer links. `overrideSettingsSearchAvailability` lets the page that gains one turn it on.
import { signal } from "nsh";
import { filterAvailableSettingsSearchItems, type SettingsSearchAvailability } from "./settingsSearch";
import { serverEnvironment, serverManagedPolicy, serverSettings } from "./settingsState";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";

const overrides = signal<Partial<SettingsSearchAvailability>>({});

/** For a feature that lands later (T3 Connect, WSL, peer links) to switch its search items on. */
export function overrideSettingsSearchAvailability(next: Partial<SettingsSearchAvailability>) {
  overrides.set({ ...overrides(), ...next });
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The availability the connected server implies. */
export function settingsSearchAvailability(): SettingsSearchAvailability {
  const connected = serverSettings() !== null;
  const capabilities = record(serverEnvironment()?.capabilities);
  const providerLimits = record(record(serverManagedPolicy()?.limits)?.providers);
  return {
    hasCloudPublicConfig: hasCloudPublicConfig(),
    hasEnvironment: connected,
    hasProviderSettingsEnvironment: connected,
    canManageLocalBackend: connected,
    isWslSettingsRowVisible: false,
    hasThreadAutoSettlement: connected,
    managedTunnelActive: false,
    // usePeerLinkHosts: offersLinkedEnvironments (capabilities.peerLinks and the Linked environments beta).
    hasPeerLinkHost: connected && capabilities?.peerLinks === true && serverSettings()?.linkedEnvironmentsEnabled === true,
    hasFastWorktreeCheckoutEnvironment: connected && capabilities?.fastWorktreeCheckout === true,
    hasTextGeneratorsEnvironment: connected && providerLimits?.allowedDrivers === undefined,
    hasPrimaryEnvironment: connected,
    ...overrides(),
  };
}

/** The items the search may list right now. */
export const availableSettingsSearchItems = () => filterAvailableSettingsSearchItems(settingsSearchAvailability());
