// The notices under the model list (ModelPickerProviderNotices in ModelPickerContent.tsx): a provider that needs setup says why
// and offers "Open provider setup" / "Set up <name>", and a provider whose models need a newer CLI says which version
// (formatProviderUpdateRequiredNotice in client-runtime/providerUpdateRequiredModels.ts).
import type { ProviderStatus } from "../../store";
import { hasProviderSetup } from "./providerStatusLogic";
import type { PickerInstance } from "./pickerModel";

/** shouldOfferModelPickerSetup: an enabled provider that is not ready, not installed, signed out, or has no model to pick. */
export function shouldOfferModelPickerSetup(status: ProviderStatus, instance: PickerInstance): boolean {
  return status.enabled && status.status !== "disabled" && hasProviderSetup(status)
    && (!instance.ready || !status.installed || status.authStatus === "unauthenticated" || !instance.models.some((model) => !model.isUnavailable));
}

/**
 * The providers whose setup the picker offers: none while searching; with a provider chosen only that one, else (Favorites)
 * only when the list is empty.
 */
export function providerSetupEntries(input: { instances: readonly PickerInstance[]; statuses: readonly ProviderStatus[]; selectedInstanceId: string | "favorites"; searching: boolean; listEmpty: boolean }): { instance: PickerInstance; status: ProviderStatus }[] {
  if (input.searching) return [];
  return input.instances.flatMap((instance) => {
    const status = input.statuses.find((entry) => entry.instanceId === instance.instanceId);
    if (!status || !shouldOfferModelPickerSetup(status, instance)) return [];
    const shown = input.selectedInstanceId === "favorites" ? input.listEmpty : instance.instanceId === input.selectedInstanceId;
    return shown ? [{ instance, status }] : [];
  });
}

/** The link text: "Open provider setup" for one provider, "Set up <name>" when several are listed. */
export const setupActionLabel = (count: number, displayName: string) => (count > 1 ? `Set up ${displayName}` : "Open provider setup");

interface UpdateRequiredModel { slug: string; name: string; minVersion: string }

const RUNTIME_NAMES: Record<string, string> = { claudeAgent: "Claude Code", codex: "the Codex CLI" };
const DISPLAY_NAMES: Record<string, string> = { antigravity: "Antigravity", codex: "Codex", claudeAgent: "Claude", cursor: "Cursor", grok: "Grok", fx: "fx", kiro: "Kiro", muse: "Muse Code", acpRegistry: "ACP Registry", pi: "Pi", opencode: "OpenCode" };

function parseVersion(value: string) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/u.exec(value.trim());
  return match ? { numbers: [Number(match[1]), Number(match[2]), Number(match[3])] as const, prerelease: match[4] ? match[4].split(".") : [] } : null;
}

/** compareSemverVersions: by core version, a release above its prereleases, non-semver by text. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left); const b = parseVersion(right);
  if (!a || !b) return left.localeCompare(right);
  for (let index = 0; index < 3; index += 1) if (a.numbers[index] !== b.numbers[index]) return a.numbers[index]! - b.numbers[index]!;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index]; const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/u.test(x); const yn = /^\d+$/u.test(y);
    if (xn && yn && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    if (!xn && x !== y) return x.localeCompare(y);
  }
  return 0;
}

const modelList = (names: readonly string[]) => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`);

/** formatProviderUpdateRequiredNotice: "Update Claude Code to v2.2.0 or newer to use A and B."; null when no listed model needs it. */
export function formatUpdateRequiredNotice(provider: { driver: string; updateRequiredModels?: readonly UpdateRequiredModel[] }, searchQuery = ""): string | null {
  const query = searchQuery.trim().toLocaleLowerCase();
  const models = (provider.updateRequiredModels ?? []).filter((model) => query.length === 0 || model.name.toLocaleLowerCase().includes(query) || model.slug.toLocaleLowerCase().includes(query));
  if (models.length === 0) return null;
  const minVersion = models.map((model) => model.minVersion).reduce((highest, version) => (compareVersions(version, highest) > 0 ? version : highest));
  const name = RUNTIME_NAMES[provider.driver] ?? DISPLAY_NAMES[provider.driver] ?? provider.driver;
  return `Update ${name} to ${minVersion.startsWith("v") ? minVersion : `v${minVersion}`} or newer to use ${modelList(models.map((model) => model.name))}.`;
}

/** The raw snapshot's `updateRequiredModels`, read defensively. */
export function readUpdateRequiredModels(record: Record<string, unknown> | undefined): UpdateRequiredModel[] {
  const list = record?.updateRequiredModels;
  return Array.isArray(list) ? list.flatMap((entry): UpdateRequiredModel[] => {
    const item = typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : null;
    return item && typeof item.slug === "string" && typeof item.name === "string" && typeof item.minVersion === "string" ? [{ slug: item.slug, name: item.name, minVersion: item.minVersion }] : [];
  }) : [];
}

/**
 * The update-required notices: while searching every provider whose listed models match, else the chosen provider's
 * (Favorites shows none).
 */
export function updateRequiredNotices(input: { instances: readonly PickerInstance[]; records: readonly Record<string, unknown>[]; selectedInstanceId: string | "favorites"; searching: boolean; query: string }): { instanceId: string; notice: string }[] {
  return input.instances.flatMap((instance) => {
    const shown = input.searching || instance.instanceId === input.selectedInstanceId;
    const record = input.records.find((entry) => entry.instanceId === instance.instanceId);
    const notice = shown ? formatUpdateRequiredNotice({ driver: instance.driver, updateRequiredModels: readUpdateRequiredModels(record) }, input.query) : null;
    return notice ? [{ instanceId: instance.instanceId, notice }] : [];
  });
}
