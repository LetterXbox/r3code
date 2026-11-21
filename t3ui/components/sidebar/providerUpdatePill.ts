// The footer pill that reports a provider's in-place update, from
// ProviderUpdateLaunchNotification.logic.ts (getProviderUpdateSidebarPillView): "Updating X" while
// one runs, then, for results newer than when the app started looking, what failed, what still
// needs an update, or what was updated.
import type { ProviderStatus } from "../../store";

export type ProviderUpdatePillTone = "loading" | "warning" | "error" | "success";

export interface ProviderUpdatePillView {
  key: string;
  dismissKeys?: string[];
  tone: ProviderUpdatePillTone;
  title: string;
  description: string;
  dismissible?: boolean;
  dismissAfterVisibleMs?: number;
}

export const PROVIDER_UPDATE_SUCCESS_VISIBLE_MS = 3_000;

type Provider = Pick<ProviderStatus, "driver" | "name" | "version" | "updateState" | "latestVersion" | "instanceId" | "checkedAt">;

const nameOf = (provider: Pick<Provider, "name" | "driver">) => provider.name || provider.driver;
const formatVersion = (value: string) => (value.startsWith("v") ? value : `v${value}`);
const finishedAt = (provider: Provider) => provider.updateState?.finishedAt ?? null;

export const isProviderUpdateActive = (provider: Pick<Provider, "updateState">) =>
  provider.updateState?.status === "queued" || provider.updateState?.status === "running";

function formatProviderList(providers: readonly Provider[]) {
  const names = providers.map(nameOf);
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** One provider per driver: the default instance (named by its driver) wins, else the first. */
function dedupeByDriver(providers: readonly Provider[]): Provider[] {
  const byDriver = new Map<string, Provider>();
  for (const provider of providers) {
    const current = byDriver.get(provider.driver);
    if (!current || provider.instanceId === provider.driver) byDriver.set(provider.driver, provider);
  }
  return [...byDriver.values()];
}

/** Each driver's latest finished instance, so an older default-instance result cannot hide it. */
function latestByDriver(providers: readonly Provider[]): Provider[] {
  const byDriver = new Map<string, Provider>();
  for (const provider of providers) {
    const current = byDriver.get(provider.driver);
    if (!current || (finishedAt(provider) ?? "") >= (finishedAt(current) ?? "")) byDriver.set(provider.driver, provider);
  }
  return [...byDriver.values()];
}

const latestFinished = (providers: readonly Provider[]) =>
  providers.reduce<string | null>((latest, provider) => {
    const at = finishedAt(provider);
    return at === null ? latest : latest === null || at > latest ? at : latest;
  }, null);

export function latestProviderCheckedAt(providers: readonly Pick<Provider, "checkedAt">[]): string | undefined {
  return providers.reduce<string | undefined>((latest, provider) => {
    const at = provider.checkedAt ?? undefined;
    return at !== undefined && (latest === undefined || at > latest) ? at : latest;
  }, undefined);
}

export function getProviderUpdatePillView(
  providers: readonly Provider[],
  options: { visibleAfterIso?: string; dismissedKeys?: ReadonlySet<string> } = {},
): ProviderUpdatePillView | null {
  const active = dedupeByDriver(providers.filter(isProviderUpdateActive));
  if (active.length > 0) {
    return {
      key: `loading:${active.map((provider) => `${provider.driver}:${provider.updateState?.status ?? "idle"}`).sort().join("|")}`,
      tone: "loading",
      title: active.length === 1 ? `Updating ${nameOf(active[0]!)}` : `Updating ${active.length} providers`,
      description: active.length === 1
        ? `${formatProviderList(active)} update in progress.`
        : `${formatProviderList(active)} updates are in progress.`,
    };
  }

  const terminalKey = (provider: Provider) =>
    `${provider.updateState?.status}:${provider.driver}:${finishedAt(provider) ?? "pending"}:${provider.updateState?.message ?? ""}`;

  const recent = latestByDriver(providers.filter((provider) => {
    const status = provider.updateState?.status;
    if (status !== "failed" && status !== "unchanged" && status !== "succeeded") return false;
    if (options.visibleAfterIso === undefined) return true;
    const at = finishedAt(provider);
    return at !== null && at >= options.visibleAfterIso;
  })).filter((provider) => !options.dismissedKeys?.has(terminalKey(provider)));
  const failed = recent.filter((provider) => provider.updateState?.status === "failed");
  const unchanged = recent.filter((provider) => provider.updateState?.status === "unchanged");
  const succeeded = recent.filter((provider) => provider.updateState?.status === "succeeded");
  const identityOf = (list: readonly Provider[]) => {
    const dismissKeys = list.map(terminalKey).sort();
    return { key: dismissKeys.join("|"), dismissKeys };
  };
  const candidates: { view: ProviderUpdatePillView; providers: Provider[] }[] = [];

  if (failed.length > 0) {
    const first = failed[0]!;
    candidates.push({
      providers: failed,
      view: {
        ...identityOf(failed),
        tone: "error",
        title: failed.length === 1
          ? (first.latestVersion ? `${nameOf(first)} ${formatVersion(first.latestVersion)} update failed` : `${nameOf(first)} update failed`)
          : `${failed.length} provider updates failed`,
        description: failed.length === 1 && first.updateState?.message
          ? first.updateState.message
          : `${formatProviderList(failed)} failed to update. Check provider settings for details.`,
        dismissible: true,
      },
    });
  }
  if (unchanged.length > 0) {
    candidates.push({
      providers: unchanged,
      view: {
        ...identityOf(unchanged),
        tone: "warning",
        title: unchanged.length === 1 ? `${nameOf(unchanged[0]!)} still needs an update` : `${unchanged.length} providers still need updates`,
        description: `${formatProviderList(unchanged)} ${unchanged.length === 1 ? "still appears" : "still appear"} outdated. Review provider settings for details.`,
        dismissible: true,
      },
    });
  }
  if (succeeded.length > 0) {
    const first = succeeded[0]!;
    candidates.push({
      providers: succeeded,
      view: {
        ...identityOf(succeeded),
        tone: "success",
        title: succeeded.length === 1
          ? (first.version ? `${nameOf(first)} updated: ${formatVersion(first.version)}` : `${nameOf(first)} updated`)
          : `${succeeded.length} providers updated`,
        description: succeeded.length === 1 ? "New sessions will use the updated provider." : "New sessions will use the updated providers.",
        dismissAfterVisibleMs: PROVIDER_UPDATE_SUCCESS_VISIBLE_MS,
      },
    });
  }
  return candidates
    .sort((left, right) => (latestFinished(right.providers) ?? "").localeCompare(latestFinished(left.providers) ?? ""))
    .map((candidate) => candidate.view)[0] ?? null;
}
