// One-time import of the V1 Electron app's Chromium Local Storage (reference: app/DesktopLegacyLocalStorage.ts,
// ipc/methods/legacyLocalStorage.ts, legacyLocalStorageMerge.ts) into this port's own storage: the prompt stash
// (components/composer/promptStash.ts) and the local environment's composer drafts (store.ts `draftStates`).
//
// Runs at most once per install: a `Storage` marker (desktop/runtime.ts seam) is set once nothing is left to retry.
// Unlike the reference (a marker file under Electron's userData), the marker here is a `Storage` key — this app
// already keeps every other one-time/"seen before" flag in `Storage` (e.g. the local-environment relaunch flag), and
// doing the same avoids adding a new nsh.json write path for a single flag file.
//
// Idempotent within a process via `importPromise`: whichever caller (store.ts `initializeBackend`, or
// promptStash.ts `hydrateStash`) runs first does the one-time work; the other awaits the same promise, so neither
// path can read/hydrate its storage key before the merge (if any) has been written.
import { desktop, type DesktopRuntime } from "./runtime";
import { readChromiumLocalStorage, ChromiumLocalStorageReadError, type LegacyFs } from "./legacyLocalStorage";
import { LEGACY_COMPOSER_DRAFTS_KEY, LEGACY_PROMPT_STASH_KEY, mergeLegacyDraftsIntoLocal, mergeLegacyPromptStash, parseLegacyComposerDrafts } from "./legacyLocalStorageMerge";
import { withDraftVersion, readVersionedDrafts } from "../draftSchema";
import { MAX_STASH_ENTRIES, type StashEntry } from "../components/composer/promptStash";

export const LEGACY_IMPORT_MARKER_KEY = "legacyLocalStorageImported";
const PROMPT_STASH_STORAGE_KEY = "promptStash:v2";
const DRAFT_STATES_STORAGE_KEY = "draftStates";
/** getDesktopUrl(false) trimmed of its trailing slash, in the reference's ElectronProtocol.ts. */
const LEGACY_DESKTOP_ORIGIN = "t3code://app";
/** DesktopLegacyLocalStorage.ts V1_PROFILE_NAMES. */
const V1_PROFILE_NAMES = ["T3 Code (Alpha)", "t3code"];

/** The subset of DesktopRuntime + fixture access this module needs, so tests can inject a fake profile layout
 * without the real runtime or a real home directory. */
export interface LegacyImportDeps {
  getItem: DesktopRuntime["getItem"];
  setItem: DesktopRuntime["setItem"];
  homeDir: DesktopRuntime["homeDir"];
  readdir: DesktopRuntime["readdir"];
  mtime: DesktopRuntime["mtime"];
  /** Reads one file out of a V1 profile's `Local Storage/leveldb` directory; `null` when missing. */
  readLevelDbFile: (profileDirectory: string, name: string) => Promise<Uint8Array | null>;
  /** Reads the port's own current prompt stash entries (parsed; empty array on any read/parse failure). */
  readCurrentStash: () => Promise<StashEntry[]>;
  writeStash: (entries: StashEntry[]) => Promise<void>;
  /** Reads the port's current `draftStates`, returning the parsed per-endpoint record (possibly `{}`) and whether a
   * value already existed (an import never creates the very first `draftStates` write, so a user who never used the
   * composer still gets a clean first save shaped by the running app, not by this import). */
  readCurrentDraftStates: () => Promise<{ states: Record<string, unknown>; existed: boolean }>;
  writeDraftStates: (states: Record<string, unknown>) => Promise<void>;
}

function depsFromRuntime(runtime: DesktopRuntime): LegacyImportDeps {
  return {
    getItem: runtime.getItem,
    setItem: runtime.setItem,
    homeDir: runtime.homeDir,
    readdir: runtime.readdir,
    mtime: runtime.mtime,
    readLevelDbFile: async (profileDirectory, name) => {
      try { return await runtime.readFile(`${profileDirectory}/${name}`); } catch { return null; }
    },
    readCurrentStash: async () => {
      try {
        const raw = await runtime.getItem(PROMPT_STASH_STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : (parsed as { entries?: unknown } | null)?.entries;
        return Array.isArray(list) ? (list as StashEntry[]) : [];
      } catch { return []; }
    },
    writeStash: (entries) => runtime.setItem(PROMPT_STASH_STORAGE_KEY, JSON.stringify(entries)),
    readCurrentDraftStates: async () => {
      const raw = await runtime.getItem(DRAFT_STATES_STORAGE_KEY);
      if (!raw) return { states: {}, existed: false };
      try {
        const parsed: unknown = JSON.parse(raw);
        const values = parsed && typeof parsed === "object" ? readVersionedDrafts(parsed as Record<string, unknown>) : null;
        return { states: values ?? {}, existed: true };
      } catch { return { states: {}, existed: true }; }
    },
    writeDraftStates: (states) => runtime.setItem(DRAFT_STATES_STORAGE_KEY, JSON.stringify(withDraftVersion(states))),
  };
}

/** `directory` is already the `.../Local Storage/leveldb` path (see `findNewestV1Directory`). */
function legacyFsFor(deps: LegacyImportDeps, directory: string): LegacyFs {
  return {
    readFile: (name) => deps.readLevelDbFile(directory, name),
    readdir: () => deps.readdir(directory),
  };
}

/** The newest V1 profile's `Local Storage/leveldb` directory under `~/Library/Application Support`, or `null` if
 * none of the V1 profile names exist. "Newest" by the directory's newest file mtime (appending to a log leaves the
 * directory's own mtime alone, matching the reference). */
async function findNewestV1Directory(deps: LegacyImportDeps): Promise<string | null> {
  const home = deps.homeDir();
  if (!home) return null;
  let newest: { directory: string; mtime: number } | null = null;
  for (const name of V1_PROFILE_NAMES) {
    const directory = `${home}/Library/Application Support/${name}/Local Storage/leveldb`;
    const names = await deps.readdir(directory);
    if (names.length === 0) continue;
    let newestFile = 0;
    for (const entry of names) {
      const mtime = await deps.mtime(`${directory}/${entry}`);
      if (mtime !== null) newestFile = Math.max(newestFile, mtime);
    }
    if (newest === null || newestFile > newest.mtime) newest = { directory, mtime: newestFile };
  }
  return newest?.directory ?? null;
}

/** Runs the one-time import against injected deps (no real filesystem or Storage involved): used directly by tests,
 * and by `ensureLegacyLocalStorageImported` for the real app. Returns `"imported"`, `"nothing-to-import"` (marker
 * written either way, since there is nothing to retry), or `"retry"` (a read failed; no marker, next launch tries
 * again, matching DesktopLegacyLocalStorage.ts's own retry semantics). */
export async function importLegacyLocalStorageWithDeps(deps: LegacyImportDeps): Promise<"imported" | "nothing-to-import" | "retry" | "already-done"> {
  if (await deps.getItem(LEGACY_IMPORT_MARKER_KEY)) return "already-done";

  const directory = await findNewestV1Directory(deps);
  if (directory === null) {
    await deps.setItem(LEGACY_IMPORT_MARKER_KEY, "1");
    return "nothing-to-import";
  }

  let items: Map<string, string>;
  try {
    items = await readChromiumLocalStorage(legacyFsFor(deps, directory), directory, LEGACY_DESKTOP_ORIGIN);
  } catch (error) {
    if (error instanceof ChromiumLocalStorageReadError) return "retry";
    throw error;
  }

  let imported = false;

  const legacyStash = items.get(LEGACY_PROMPT_STASH_KEY);
  if (legacyStash !== undefined) {
    const current = await deps.readCurrentStash();
    const merged = mergeLegacyPromptStash(current, legacyStash, MAX_STASH_ENTRIES);
    if (merged !== null) {
      await deps.writeStash(merged);
      imported = true;
    }
  }

  const legacyDraftsRaw = items.get(LEGACY_COMPOSER_DRAFTS_KEY);
  if (legacyDraftsRaw !== undefined) {
    const legacyDrafts = parseLegacyComposerDrafts(legacyDraftsRaw);
    if (legacyDrafts !== null && legacyDrafts.length > 0) {
      const { states, existed } = await deps.readCurrentDraftStates();
      // store.ts readDraftState requires `threads` to be an array; `options`/`attachments`/`selectedId` default fine
      // when absent, so only `threads` needs an explicit default for a local state this import creates from scratch.
      const localState = (states[""] as { drafts?: Record<string, string>; threads?: unknown[] } | undefined) ?? { drafts: {}, threads: [] };
      const mergedDrafts = mergeLegacyDraftsIntoLocal(localState.drafts ?? {}, legacyDrafts);
      if (mergedDrafts !== null) {
        const nextStates = { ...states, "": { ...localState, threads: localState.threads ?? [], drafts: mergedDrafts } };
        await deps.writeDraftStates(nextStates);
        imported = true;
        void existed; // `existed` documents the design choice above; nothing branches on it.
      }
    }
  }

  await deps.setItem(LEGACY_IMPORT_MARKER_KEY, "1");
  return imported ? "imported" : "nothing-to-import";
}

let importPromise: Promise<void> | null = null;

/** Memoized for the process: the first caller does the work (or discovers there is nothing to do), every later
 * caller awaits the same promise. Never rejects — a read failure is logged and left for the next launch to retry,
 * since neither caller (`initializeBackend`, `hydrateStash`) should fail its own startup over this. */
export function ensureLegacyLocalStorageImported(): Promise<void> {
  importPromise ??= importLegacyLocalStorageWithDeps(depsFromRuntime(desktop())).then(
    () => undefined,
    () => undefined,
  );
  return importPromise;
}

/** Tests only: forces the next call to `ensureLegacyLocalStorageImported` to run again. */
export function resetLegacyLocalStorageImportForTest(): void {
  importPromise = null;
}
