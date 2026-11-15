// The "Run on" choices (BranchToolbar.logic.ts EnvironmentOption): the connected environment, then the saved
// ones this app can switch to. The port keeps one live connection, so a saved environment is picked by
// connecting to it.
export type MachineKind = "laptop" | "server";

export interface EnvironmentOption {
  /** The connected environment's id, or a saved environment's id. */
  environmentId: string;
  label: string;
  isPrimary: boolean;
  machine: MachineKind;
  /** The address to connect to, for a saved environment. */
  url: string | null;
  /** useLogicalProjectEnvironments: the store id of the project's checkout on this environment. */
  projectId?: string | null;
}

const LOCAL_HOST = /^wss?:\/\/(localhost|127\.|\[::1\])/i;

export function machineKindForUrl(url: string | null): MachineKind {
  return url !== null && LOCAL_HOST.test(url) ? "laptop" : "server";
}

export function buildEnvironmentOptions(input: {
  connected: { id: string; label: string } | null;
  currentUrl: string;
  saved: ReadonlyArray<{ id: string; label: string; url: string; enabled: boolean }>;
}): EnvironmentOption[] {
  const primary: EnvironmentOption[] = input.connected
    ? [{ environmentId: input.connected.id, label: input.connected.label, isPrimary: true, machine: machineKindForUrl(input.currentUrl), url: null }]
    : [];
  const others = input.saved
    .filter((item) => item.enabled && item.url !== input.currentUrl && item.id !== input.connected?.id)
    .map((item): EnvironmentOption => ({ environmentId: item.id, label: item.label, isPrimary: false, machine: machineKindForUrl(item.url), url: item.url }));
  return [...primary, ...others];
}

/** shouldShowEnvironmentIndicator: the picker or a locked label shows when there is more than one machine to name. */
export function shouldShowEnvironmentIndicator(input: { options: readonly EnvironmentOption[]; activeId: string | null }): boolean {
  if (input.options.length > 1) return true;
  const active = input.options.find((item) => item.environmentId === input.activeId);
  return active !== undefined && !active.isPrimary;
}
