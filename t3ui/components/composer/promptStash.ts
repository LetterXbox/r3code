// The prompt stash (promptStashStore.ts + useComposerStash.ts): mod+s sets the composer's prompt
// aside and clears it; mod+s with an empty composer restores the only entry, or opens the stash
// menu when there are several. The newest entry is first and the stash holds 20. Entries persist on
// this device (the web keeps them in localStorage).
//
// An entry carries the draft's uploaded attachments (their server upload ids): stashing moves them out of
// the draft without deleting the uploads and restoring puts them back, as the web's stash does.
import { signal, Storage } from "nsh";
import { ensureLegacyLocalStorageImported } from "../../desktop/legacyLocalStorageImport";

export const MAX_STASH_ENTRIES = 20;
const STORAGE_KEY = "promptStash:v2";
export const SNIPPET_MAX_CHARS = 90;

/** An uploaded draft attachment as an entry keeps it (`file` holds the bytes for thumbnails while the app runs). */
export interface StashAttachment { id: string; name: string; mimeType: string; sizeBytes: number; kind: "image" | "file"; status: "uploaded"; uploadedId: string; file?: File }
export interface StashEntry { id: string; createdAt: string; prompt: string; attachments?: StashAttachment[]; /** promptStashStore.ts:31: the composer's context records (pull request, thread, terminal, annotation chips). */ records?: StashRecord[] }
/** A context record as the composer holds it (contextChips.ts); kept opaque here and validated by kind/contextId. */
export type StashRecord = { kind: string; contextId: string } & Record<string, unknown>;

const entries = signal<StashEntry[]>([]);
const pulse = signal(0);
export const stashEntries = () => entries();
/** Bumped per stash; the badge replays its pulse on each new value. 0 means never pulsed. */
export const stashPulseKey = () => pulse();

/** Newest first, capped at MAX_STASH_ENTRIES; the oldest entry that no longer fits is returned. */
export function addEntry(list: readonly StashEntry[], entry: StashEntry): { entries: StashEntry[]; evicted: StashEntry | null } {
  const next = [entry, ...list];
  const evicted = next.length > MAX_STASH_ENTRIES ? (next.pop() ?? null) : null;
  return { entries: next, evicted };
}

export function removeEntry(list: readonly StashEntry[], id: string): { entries: StashEntry[]; entry: StashEntry | null } {
  const entry = list.find((candidate) => candidate.id === id) ?? null;
  return { entries: list.filter((candidate) => candidate.id !== id), entry };
}

/** stashEntrySnippet: the prompt on one line, cut at 90 characters. */
export function stashEntrySnippet(entry: Pick<StashEntry, "prompt"> & { attachments?: readonly Pick<StashAttachment, "kind">[] }): string {
  const trimmed = entry.prompt.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) {
    const attachments = entry.attachments ?? [];
    if (attachments.length === 0) return "(empty)";
    const images = attachments.filter((item) => item.kind === "image").length;
    const files = attachments.length - images;
    const label = images > 0 && files > 0 ? "attachment" : files > 0 ? "file" : "image";
    return `(${attachments.length} ${label}${attachments.length === 1 ? "" : "s"})`;
  }
  return trimmed.length > SNIPPET_MAX_CHARS ? `${trimmed.slice(0, SNIPPET_MAX_CHARS)}…` : trimmed;
}

/** Restoring appends to a prompt that already has text, after a blank line. */
export function restoredPrompt(current: string, stashed: string): string {
  if (stashed.length === 0) return current;
  return current.trim().length > 0 ? `${current.replace(/\s+$/, "")}\n\n${stashed}` : stashed;
}

export function parseStoredEntries(raw: string | null): StashEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : (parsed as { entries?: unknown } | null)?.entries;
    if (!Array.isArray(list)) return [];
    return list.flatMap((item): StashEntry[] => {
      const entry = item as Partial<StashEntry> | null;
      if (!(entry && typeof entry.id === "string" && typeof entry.createdAt === "string" && typeof entry.prompt === "string")) return [];
      const attachments = Array.isArray(entry.attachments) ? entry.attachments.flatMap((raw): StashAttachment[] => {
        const item = raw as Partial<StashAttachment> | null;
        return item && typeof item.id === "string" && typeof item.uploadedId === "string" && typeof item.name === "string" && typeof item.mimeType === "string"
          && typeof item.sizeBytes === "number" && (item.kind === "image" || item.kind === "file")
          ? [{ id: item.id, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes, kind: item.kind, status: "uploaded", uploadedId: item.uploadedId }] : [];
      }) : [];
      const records = Array.isArray(entry.records) ? entry.records.filter((record): record is StashRecord => typeof record === "object" && record !== null && typeof (record as StashRecord).kind === "string" && typeof (record as StashRecord).contextId === "string") : [];
      return [{ id: entry.id, createdAt: entry.createdAt, prompt: entry.prompt, ...(attachments.length > 0 ? { attachments } : {}), ...(records.length > 0 ? { records } : {}) }];
    }).slice(0, MAX_STASH_ENTRIES);
  } catch { return []; }
}

let hydrated = false;
export function hydrateStash() {
  if (hydrated) return;
  hydrated = true;
  // The one-time V1 import (desktop/legacyLocalStorageImport.ts) may still be merging legacy entries into this key;
  // await it first so a hydrate that races the import never reads a stale value.
  void ensureLegacyLocalStorageImported().then(() => Storage.getItem(STORAGE_KEY)).then((raw) => {
    const stored = parseStoredEntries(raw);
    if (stored.length === 0) return;
    // Anything stashed before the read finished stays on top.
    entries.update((current) => [...current, ...stored.filter((entry) => !current.some((item) => item.id === entry.id))].slice(0, MAX_STASH_ENTRIES));
  }).catch(() => {});
}

function persist(): Promise<boolean> {
  // The bytes stay in memory; the upload id is what travels.
  const serializable = entries().map((entry) => ({ ...entry, ...(entry.attachments ? { attachments: entry.attachments.map(({ file: _file, ...item }) => item) } : {}) }));
  return Storage.setItem(STORAGE_KEY, JSON.stringify(serializable)).then(() => true, () => false);
}

/** useComposerStash (promptStashStore.ts:97-108): the entry is kept only once the write succeeded; a refused write rolls
 * the stash back and resolves written: false, so the caller leaves the composer as it was. */
export async function stashPromptDurably(prompt: string, now = Date.now(), attachments: readonly StashAttachment[] = [], records: readonly StashRecord[] = []): Promise<{ evicted: StashEntry | null; written: boolean }> {
  hydrateStash();
  const before = entries();
  const entry: StashEntry = { id: `stash:${crypto.randomUUID()}`, createdAt: new Date(now).toISOString(), prompt, ...(attachments.length > 0 ? { attachments: [...attachments] } : {}), ...(records.length > 0 ? { records: [...records] } : {}) };
  const result = addEntry(before, entry);
  entries.set(result.entries);
  if (!(await persist())) {
    entries.set(entries().filter((item) => item.id !== entry.id));
    return { evicted: null, written: false };
  }
  pulse.update((key) => key + 1);
  return { evicted: result.evicted, written: true };
}

/** Sets the prompt aside. Returns the entry dropped to make room, if any. */
export function stashPrompt(prompt: string, now = Date.now(), attachments: readonly StashAttachment[] = []): StashEntry | null {
  hydrateStash();
  const entry: StashEntry = { id: `stash:${crypto.randomUUID()}`, createdAt: new Date(now).toISOString(), prompt, ...(attachments.length > 0 ? { attachments: [...attachments] } : {}) };
  const result = addEntry(entries(), entry);
  entries.set(result.entries);
  pulse.update((key) => key + 1);
  void persist();
  return result.evicted;
}

export function takeStashEntry(id: string): StashEntry | null {
  const result = removeEntry(entries(), id);
  if (!result.entry) return null;
  entries.set(result.entries);
  void persist();
  return result.entry;
}

/** Test seam: empties the in-memory stash. */
export function resetStashForTests() {
  entries.set([]);
  pulse.set(0);
  hydrated = true;
}
