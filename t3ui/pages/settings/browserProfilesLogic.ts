// BrowserProfilesSetting (IntegrationsSettings.tsx) and contracts browserProfile.ts: the built-in Default and Incognito
// profiles, the user's own, the limits, and the edits the profiles row makes. The user's profiles are kept in the
// client setting `browserProfiles` (JSON text here: a client setting holds one scalar) beside `browserDefaultProfileId`.
export interface BrowserProfile { id: string; name: string; kind: "persistent" | "incognito" }

export const BROWSER_PROFILE_NAME_MAX_LENGTH = 48;
export const BROWSER_PROFILE_MAX_COUNT = 24;
export const DEFAULT_BROWSER_PROFILE_ID = "default";
export const INCOGNITO_BROWSER_PROFILE_ID = "incognito";
export const BUILT_IN_BROWSER_PROFILES: readonly BrowserProfile[] = [
  { id: DEFAULT_BROWSER_PROFILE_ID, name: "Default", kind: "persistent" },
  { id: INCOGNITO_BROWSER_PROFILE_ID, name: "Incognito", kind: "incognito" },
];

export const isBuiltInProfileId = (id: string) => BUILT_IN_BROWSER_PROFILES.some((profile) => profile.id === id);

/** The user's saved profiles, tolerant of a malformed value. */
export function parseUserProfiles(value: unknown): BrowserProfile[] {
  let raw: unknown = value;
  if (typeof value === "string") { try { raw = JSON.parse(value); } catch { return []; } }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): BrowserProfile[] => {
    const item = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : null;
    if (!item || typeof item.id !== "string" || !item.id.trim() || typeof item.name !== "string" || !item.name.trim()) return [];
    return [{ id: item.id, name: item.name.slice(0, BROWSER_PROFILE_NAME_MAX_LENGTH), kind: "persistent" }];
  }).slice(0, BROWSER_PROFILE_MAX_COUNT);
}

/** resolveBrowserProfiles: the built-ins first, then the user's, a profile sharing a built-in id dropped. */
export function resolveProfiles(user: readonly BrowserProfile[]): BrowserProfile[] {
  const seen = new Set(BUILT_IN_BROWSER_PROFILES.map((profile) => profile.id));
  const out = [...BUILT_IN_BROWSER_PROFILES];
  for (const profile of user) {
    if (seen.has(profile.id)) continue;
    seen.add(profile.id);
    out.push({ ...profile, kind: "persistent" });
  }
  return out;
}

/** What the list shows: every profile but Incognito. */
export const listedProfiles = (user: readonly BrowserProfile[]) => resolveProfiles(user).filter((profile) => profile.kind !== "incognito");

/** createProfile: a free name (`New profile`, `New profile 2` ...); null at the limit. */
export function createProfile(user: readonly BrowserProfile[], baseName: string, id: string): { profiles: BrowserProfile[]; created: BrowserProfile } | null {
  if (user.length >= BROWSER_PROFILE_MAX_COUNT) return null;
  const taken = new Set(resolveProfiles(user).map((profile) => profile.name));
  let name = baseName;
  for (let index = 2; taken.has(name); index += 1) name = `${baseName} ${index}`;
  const created: BrowserProfile = { id, name, kind: "persistent" };
  return { profiles: [...user, created], created };
}

/** renameProfile: trimmed and capped; an empty name changes nothing. */
export function renameProfile(user: readonly BrowserProfile[], id: string, next: string): BrowserProfile[] {
  const name = next.trim().slice(0, BROWSER_PROFILE_NAME_MAX_LENGTH);
  return name === "" ? [...user] : user.map((profile) => (profile.id === id ? { ...profile, name } : profile));
}

/** removeProfile: the profile goes, and the default falls back to Default when it was the default. */
export function removeProfile(user: readonly BrowserProfile[], defaultId: string, id: string): { profiles: BrowserProfile[]; defaultId: string } {
  return { profiles: user.filter((profile) => profile.id !== id), defaultId: defaultId === id ? DEFAULT_BROWSER_PROFILE_ID : defaultId };
}

/** The default the row shows: the saved one if it is still listed, else Default. */
export const resolvedDefaultId = (user: readonly BrowserProfile[], saved: string): string => (listedProfiles(user).some((profile) => profile.id === saved) ? saved : DEFAULT_BROWSER_PROFILE_ID);
