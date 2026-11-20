// Scoped-down port of the reference's legacyLocalStorageMerge.ts for exactly the two keys the task calls out: the
// prompt stash and composer drafts (apps/web/src/promptStashStore.ts, composerDraftStore.ts). The reference merges
// every V1 localStorage key generically into a V2 localStorage that has the *same* shapes; this port's drafts/stash
// storage uses different shapes (t3ui/components/composer/promptStash.ts, t3ui/store.ts `draftStates`), so each key
// gets its own adapter instead of a generic deep-merge.
// A structural subset of components/composer/promptStash.ts's StashEntry, kept local (rather than imported) so this
// module has no runtime dependency on promptStash.ts — that file in turn depends on
// desktop/legacyLocalStorageImport.ts (which imports this one), and a value-level cycle through three modules is
// worth avoiding even though ESM would tolerate it here (nothing above is read at module-evaluation time).
interface MergeableStashEntry { id: string; createdAt: string; prompt: string; records?: unknown }

export const LEGACY_PROMPT_STASH_KEY = "t3code:prompt-stash:v2";
export const LEGACY_COMPOSER_DRAFTS_KEY = "t3code:composer-drafts:v1";
/** Matches COMPOSER_DRAFT_STORAGE_VERSION in apps/web/src/composerDraftStore.ts; this port's DRAFT_STORAGE_VERSION
 * (draftSchema.ts) is the same number by design, but drafts are still version-checked independently of that file so a
 * future bump of either does not silently start merging incompatible shapes. */
const LEGACY_COMPOSER_DRAFTS_VERSION = 9;
/** scopedThreadKey (packages/client-runtime/src/environment/scoped.ts): `${environmentId}:${threadId}`. Only the
 * local environment's drafts have a corresponding thread namespace in this app (both this port and V1 talk to the
 * same local server-rs/t3code state database, so thread ids carry over); drafts under any other legacy environment id
 * (SSH/remote) are not imported; see store.ts `LOCAL_ENVIRONMENT_ID` usage via `connectionUrl() === ""`. */
const LOCAL_LEGACY_ENVIRONMENT_ID = "local";

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

function parseObject(raw: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The legacy entry shape (promptStashStore.ts StashEntrySchema) trimmed to the fields the port's StashEntry keeps;
 * image/file attachments are dataURL-shaped in V1 and dropped here (lossy; the port's own parseStoredEntries would
 * drop them too since they do not match StashAttachment). */
function legacyStashEntries(legacy: JsonObject): MergeableStashEntry[] {
  const entries = isObject(legacy.state) ? legacy.state.entries : null;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((raw) => {
    const entry = raw as Partial<{ id: unknown; createdAt: unknown; prompt: unknown; records: unknown }> | null;
    if (!entry || typeof entry.id !== "string" || typeof entry.createdAt !== "string" || typeof entry.prompt !== "string") return [];
    return [{ id: entry.id, createdAt: entry.createdAt, prompt: entry.prompt, ...(Array.isArray(entry.records) ? { records: entry.records } : {}) }];
  });
}

/** Appends legacy stash entries (parsed from the raw `t3code:prompt-stash:v2` V1 value) after the port's current
 * entries, skipping ids already present, newest-first order kept, capped at MAX_STASH_ENTRIES (current entries win
 * the cap, matching the reference's "stash first" ordering). `null` when the legacy value does not parse. */
export function mergeLegacyPromptStash<E extends MergeableStashEntry>(current: readonly E[], legacyRaw: string, maxEntries: number): E[] | null {
  const legacy = parseObject(legacyRaw);
  if (legacy === null) return null;
  const legacyEntries = legacyStashEntries(legacy);
  if (legacyEntries.length === 0) return null;
  const ids = new Set(current.map((entry) => entry.id));
  const added = legacyEntries.filter((entry) => !ids.has(entry.id));
  if (added.length === 0) return null;
  const merged = [...current, ...(added as E[])].slice(0, maxEntries);
  // A full stash drops every added entry in the slice above; nothing actually changed.
  return merged.length === current.length ? null : merged;
}

/** Parses the raw `t3code:composer-drafts:v1` V1 value into `{ threadId, prompt }` pairs for the local environment
 * only, non-empty prompts only. Returns `null` when the value does not parse or its `version` does not match
 * (the reference refuses to merge across a version mismatch rather than guess at a changed shape). */
export function parseLegacyComposerDrafts(legacyRaw: string): Array<{ threadId: string; prompt: string }> | null {
  const legacy = parseObject(legacyRaw);
  if (legacy === null || legacy.version !== LEGACY_COMPOSER_DRAFTS_VERSION) return null;
  const state = legacy.state;
  if (!isObject(state) || !isObject(state.draftsByThreadKey)) return null;
  const drafts: Array<{ threadId: string; prompt: string }> = [];
  for (const [scopedKey, value] of Object.entries(state.draftsByThreadKey)) {
    const separatorIndex = scopedKey.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex >= scopedKey.length - 1) continue;
    const environmentId = scopedKey.slice(0, separatorIndex);
    const threadId = scopedKey.slice(separatorIndex + 1);
    if (environmentId !== LOCAL_LEGACY_ENVIRONMENT_ID) continue;
    const prompt = isObject(value) ? value.prompt : null;
    if (typeof prompt === "string" && prompt.length > 0) drafts.push({ threadId, prompt });
  }
  return drafts;
}

/** Fills in the local endpoint's drafts (`draftsByEnvironment.get("")`) from legacy per-thread prompts, without
 * overwriting a draft the port already has for that thread id (current wins, matching the reference). Returns `null`
 * when nothing changed. */
export function mergeLegacyDraftsIntoLocal(current: Readonly<Record<string, string>>, legacy: ReadonlyArray<{ threadId: string; prompt: string }>): Record<string, string> | null {
  let changed = false;
  const next = { ...current };
  for (const { threadId, prompt } of legacy) {
    if (next[threadId] !== undefined) continue;
    next[threadId] = prompt;
    changed = true;
  }
  return changed ? next : null;
}
