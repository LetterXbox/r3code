// The settings search, ported from components/settings/settingsSearch.ts: every query token
// has to match the item's title, its page's name or one of its keywords; results rank exact
// title > title prefix > title contains > all tokens in the title > phrase in a keyword; items
// marked `secondary` (the 87 keybinding commands) always follow the rest. The index itself
// (SETTINGS_SEARCH_ITEMS) is generated from the shipped settings defaults.
//
// Pure: no signals. The store feeds it the availability it reads from the connected server.
import {
  SETTINGS_CATEGORY_SCOPES,
  SETTINGS_SEARCH_ITEMS,
  SETTINGS_SECTION_LABELS,
  type SettingsSearchItem,
  type SettingsSearchScope,
} from "../../settingsPanels";

export type { SettingsSearchItem, SettingsSearchScope };
export { SETTINGS_SECTION_LABELS };

/** What the connected environment makes available; mirrors the web's SettingsSearchAvailability. */
export interface SettingsSearchAvailability {
  localEnvironmentDisabled?: boolean;
  hasCloudPublicConfig: boolean;
  hasEnvironment: boolean;
  hasProviderSettingsEnvironment: boolean;
  canManageLocalBackend: boolean;
  isWslSettingsRowVisible: boolean;
  hasThreadAutoSettlement: boolean;
  managedTunnelActive?: boolean;
  hasPeerLinkHost?: boolean;
  hasFastWorktreeCheckoutEnvironment?: boolean;
  /** An environment without a provider allow-list, which hides text generators. */
  hasTextGeneratorsEnvironment?: boolean;
  hasPrimaryEnvironment?: boolean;
}

/** The platform the app runs on; the native app is a macOS desktop app. */
export interface SettingsSearchPlatform {
  desktop: boolean;
  mac: boolean;
  windows: boolean;
  /** A hosted channel exists only for the web app; desktop builds always have release tracks. */
  hostedChannel: boolean;
  secretsEnabled: boolean;
}

export const NATIVE_SEARCH_PLATFORM: SettingsSearchPlatform = {
  desktop: true,
  mac: true,
  windows: false,
  hostedChannel: false,
  secretsEnabled: false,
};

let diacritics: RegExp | null = null;
try {
  diacritics = new RegExp("\\p{M}", "gu");
} catch {
  diacritics = null;
}

/** `normalizeSearchText` (lib/utils.ts): NFKD, no combining marks, lower case, single spaces, trimmed. */
export function normalizeSearchText(value: string): string {
  let text = value;
  try {
    text = text.normalize("NFKD");
  } catch {
    // An engine without normalize keeps the text as written.
  }
  if (diacritics) text = text.replace(diacritics, "");
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** The settings that exist on this platform and app channel (`settingsForThisPlatform`). */
export function settingsForThisPlatform(
  items: readonly SettingsSearchItem[],
  platform: SettingsSearchPlatform = NATIVE_SEARCH_PLATFORM,
): SettingsSearchItem[] {
  return items.filter(
    (item) =>
      (platform.desktop || item.desktopOnly !== true) &&
      (!item.releaseChannelOnly || platform.desktop || platform.hostedChannel) &&
      (!item.secretsFeatureOnly || platform.secretsEnabled) &&
      (!item.macOnly || platform.mac) &&
      (!item.windowsOnly || platform.windows),
  );
}

/** Items the connected environments can actually offer (`filterAvailableSettingsSearchItems`). */
export function filterAvailableSettingsSearchItems(
  availability: SettingsSearchAvailability,
  items: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS,
): SettingsSearchItem[] {
  return items.filter(
    (item) =>
      (!item.cloudOnly || availability.hasCloudPublicConfig) &&
      (!item.environmentOnly || availability.hasEnvironment) &&
      (!item.providerSettingsOnly || availability.hasProviderSettingsEnvironment) &&
      (!item.localBackendManagementOnly || availability.canManageLocalBackend) &&
      (!item.localEnvironmentOnly || !availability.localEnvironmentDisabled) &&
      (!item.primaryEnvironmentOnly || availability.hasPrimaryEnvironment === true) &&
      (!item.wslAvailableOnly || availability.isWslSettingsRowVisible) &&
      (!item.requiresThreadAutoSettlement || availability.hasThreadAutoSettlement) &&
      (!item.managedTunnelOnly || availability.managedTunnelActive === true) &&
      (!item.peerLinksOnly || availability.hasPeerLinkHost === true) &&
      (!item.fastWorktreeCheckoutOnly || availability.hasFastWorktreeCheckoutEnvironment === true) &&
      (!item.textGeneratorsOnly || availability.hasTextGeneratorsEnvironment === true),
  );
}

/** Matching and ranking, `searchSettings`. */
export function searchSettings(
  query: string,
  items: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS,
  platform: SettingsSearchPlatform = NATIVE_SEARCH_PLATFORM,
): SettingsSearchItem[] {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];
  const queryTokens = normalizedQuery.split(" ");
  const ranked: { item: SettingsSearchItem; index: number; rank: number }[] = [];
  settingsForThisPlatform(items, platform).forEach((item, index) => {
    const title = normalizeSearchText(item.title);
    const fields = [
      title,
      normalizeSearchText(SETTINGS_SECTION_LABELS[item.to] ?? ""),
      ...(item.searchTerms ?? []).map(normalizeSearchText),
    ];
    if (!queryTokens.every((token) => fields.some((field) => field.includes(token)))) return;
    const exactPhraseField = fields.findIndex((field) => field.includes(normalizedQuery));
    const rank =
      title === normalizedQuery
        ? 5
        : title.startsWith(normalizedQuery)
          ? 4
          : title.includes(normalizedQuery)
            ? 3
            : queryTokens.every((token) => title.includes(token))
              ? 2
              : exactPhraseField >= 0
                ? 1
                : 0;
    ranked.push({ item, index, rank });
  });
  ranked.sort(
    (left, right) =>
      Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false) ||
      right.rank - left.rank ||
      left.index - right.index,
  );
  return ranked.map(({ item }) => item);
}

/** The row a result reveals: its `targetId` when it names one, else its own id. */
export const searchTargetId = (item: Pick<SettingsSearchItem, "id" | "targetId">) => item.targetId ?? item.id;

/** `isSettingsSearchScopeAvailable`: whether a settings target can be changed at the selected scope. */
export function isSettingsSearchScopeAvailable(
  requiredScope: SettingsSearchScope | null | undefined,
  scopeKind: string,
): boolean {
  switch (requiredScope ?? null) {
    case null:
    case "connections":
      return true;
    case "environment":
    case "checkout":
      return requiredScope === scopeKind;
    case "project":
      return scopeKind === "project" || scopeKind === "checkout";
    case "environment-defaults":
      return scopeKind === "environment" || scopeKind === "all";
    case "project-defaults":
      return scopeKind === "environment" || scopeKind === "all" || scopeKind === "project" || scopeKind === "checkout";
  }
  return true;
}

/** `getSettingsSearchTargetScope`: the title and scope a revealed target needs. */
export function settingsSearchTargetScope(targetId: string) {
  const item =
    SETTINGS_SEARCH_ITEMS.find((candidate) => candidate.id === targetId) ??
    SETTINGS_SEARCH_ITEMS.find((candidate) => candidate.targetId === targetId);
  if (!item) return null;
  return {
    title: item.title,
    scope: item.scope ?? SETTINGS_CATEGORY_SCOPES[item.to] ?? null,
    requiresThreadAutoSettlement: item.requiresThreadAutoSettlement === true,
  };
}
