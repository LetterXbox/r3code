// Usage page selection state: which environments and providers are included, and the dialogs.
import { signal, Storage } from "nsh";
import { serverEnvironment } from "../../pages/settings/settingsState";
import { backendStatus, backendUrl, restoreUsagePagePreferences } from "../../store";
import { buildUsageEnvironmentList, savedUsageEnvironments, savedUsageStatuses } from "./usageEnvironments";
import { toggleAllEnvironments, toggleEnvironment, toggleAllProviders, toggleProvider, type EnvironmentSelection, type UsageEnvironmentEntry } from "./usageSelection";

const selection = signal<EnvironmentSelection>(null);
export const usageEnvironmentSelection = () => selection();

/** The environments the page can read: the live connection and the enabled saved environments (usageEnvironments.ts). */
export function usageEnvironmentList(): UsageEnvironmentEntry[] {
  const label = serverEnvironment()?.label;
  return buildUsageEnvironmentList({
    primary: backendStatus() === "disconnected" ? null : { id: backendUrl() || "local", label: typeof label === "string" && label ? label : "This device", connected: backendStatus() === "connected" },
    saved: savedUsageEnvironments(),
    statuses: savedUsageStatuses(),
  });
}

export function setAllEnvironments(checked: boolean) { selection.set(toggleAllEnvironments(checked)); }
export function setEnvironmentChecked(id: string, checked: boolean) {
  selection.set(toggleEnvironment(usageEnvironmentList(), selection(), id, checked));
}

const hidden = signal<string[]>([]);
export const usageHiddenProviders = () => hidden();

function saveHidden() {
  void Storage.setItem("usageHiddenProviders", JSON.stringify(hidden())).catch(() => undefined);
}

export function setAllProviders(checked: boolean) { hidden.set(toggleAllProviders(checked)); saveHidden(); }
export function setProviderChecked(provider: string, checked: boolean) { hidden.set(toggleProvider(hidden(), provider, checked)); saveHidden(); }

let restored = false;
export function restoreUsagePreferences() {
  if (restored) return;
  restored = true;
  restoreUsagePagePreferences();
  void Storage.getItem("usageHiddenProviders").then((raw) => {
    if (typeof raw !== "string") return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) hidden.set(parsed);
    } catch { /* ignore a corrupt preference */ }
  }).catch(() => undefined);
}

export type UsageDialog = { kind: "model"; provider: string; model: string } | { kind: "prices"; model?: string } | null;
const dialog = signal<UsageDialog>(null);
export const usageDialog = () => dialog();
export function openUsageDialog(next: UsageDialog) { dialog.set(next); }
