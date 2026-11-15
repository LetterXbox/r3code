// composerDraftStore.ts COMPOSER_DRAFT_STORAGE_VERSION: the saved drafts carry a schema version and a store written
// by another version is rejected instead of half-read. The saved object is keyed by environment URL, so the version
// rides under a reserved non-URL key; a store without one is the unversioned shape this version still reads (migrated).
export const DRAFT_STORAGE_VERSION = 9;
export const DRAFT_VERSION_KEY = "__version";

export function withDraftVersion(saved: Record<string, unknown>): Record<string, unknown> {
  return { [DRAFT_VERSION_KEY]: DRAFT_STORAGE_VERSION, ...saved };
}

/** The per-environment entries of a saved store, or null when it was written by a different schema version. */
export function readVersionedDrafts(values: Record<string, unknown>): Record<string, unknown> | null {
  const version = values[DRAFT_VERSION_KEY];
  if (version !== undefined && version !== DRAFT_STORAGE_VERSION) return null;
  const { [DRAFT_VERSION_KEY]: _version, ...entries } = values;
  return entries;
}
