// Deps-injected tests for the one-time import orchestrator: no real Storage, filesystem, or home directory. A fake
// `LegacyImportDeps` stands in for desktop/runtime.ts.
import { expect, test } from "nsh/test";
import { importLegacyLocalStorageWithDeps, LEGACY_IMPORT_MARKER_KEY, type LegacyImportDeps } from "./legacyLocalStorageImport";
import type { StashEntry } from "../components/composer/promptStash";

interface FakeProfile { leveldbFiles: Map<string, Uint8Array>; mtimes: Map<string, number> }

function makeDeps(options: { home: string | null; profiles?: Record<string, FakeProfile>; currentStash?: StashEntry[]; currentDraftStates?: Record<string, unknown> }): { deps: LegacyImportDeps; storage: Map<string, string> } {
  const storage = new Map<string, string>();
  const profiles = options.profiles ?? {};
  let stash = options.currentStash ?? [];
  let draftStates = options.currentDraftStates ?? {};
  const deps: LegacyImportDeps = {
    getItem: async (key) => storage.get(key) ?? null,
    setItem: async (key, value) => { storage.set(key, value); },
    homeDir: () => options.home,
    readdir: async (path) => {
      for (const [name, profile] of Object.entries(profiles)) {
        if (path.endsWith(`${name}/Local Storage/leveldb`)) return [...profile.leveldbFiles.keys()];
      }
      return [];
    },
    mtime: async (path) => {
      for (const profile of Object.values(profiles)) {
        const direct = profile.mtimes.get(path.split("/").pop()!);
        if (direct !== undefined) return direct;
      }
      return null;
    },
    readLevelDbFile: async (profileDirectory, name) => {
      for (const [profileName, profile] of Object.entries(profiles)) {
        if (profileDirectory.endsWith(`${profileName}/Local Storage/leveldb`)) return profile.leveldbFiles.get(name) ?? null;
      }
      return null;
    },
    readCurrentStash: async () => stash,
    writeStash: async (entries) => { stash = entries; },
    readCurrentDraftStates: async () => ({ states: draftStates, existed: Object.keys(draftStates).length > 0 }),
    writeDraftStates: async (states) => { draftStates = states; },
  };
  return { deps, storage };
}

test("writes the marker and reports nothing-to-import when no V1 profile exists", async () => {
  const { deps, storage } = makeDeps({ home: "/home/tester" });
  const result = await importLegacyLocalStorageWithDeps(deps);
  expect(result).toBe("nothing-to-import");
  expect(storage.get(LEGACY_IMPORT_MARKER_KEY)).toBe("1");
});

test("short-circuits once the marker is already set", async () => {
  const { deps, storage } = makeDeps({ home: "/home/tester" });
  storage.set(LEGACY_IMPORT_MARKER_KEY, "1");
  expect(await importLegacyLocalStorageWithDeps(deps)).toBe("already-done");
});

test("does nothing when HOME is unset (never guesses a path)", async () => {
  const { deps, storage } = makeDeps({ home: null });
  expect(await importLegacyLocalStorageWithDeps(deps)).toBe("nothing-to-import");
  expect(storage.get(LEGACY_IMPORT_MARKER_KEY)).toBe("1");
});

test("retries next launch when the V1 directory exists but cannot be read, and does not set the marker", async () => {
  const { deps, storage } = makeDeps({
    home: "/home/tester",
    profiles: { "T3 Code (Alpha)": { leveldbFiles: new Map([["CURRENT", new Uint8Array()]]), mtimes: new Map([["CURRENT", 1]]) } },
  });
  const result = await importLegacyLocalStorageWithDeps(deps);
  expect(result).toBe("retry");
  expect(storage.has(LEGACY_IMPORT_MARKER_KEY)).toBe(false);
});
