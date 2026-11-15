// The per-view state behind context expansion: each file's fetched texts (the FileDiffContentsLoader's result, fetched
// once on the first press of a separator, as Pierre hydrates a partial diff) and which lines of each gap are revealed.
// Keyed by the caller's file key; a key's state is dropped when its patch text changes or the view's context resets.
import { signal } from "nsh";
import { expandFilePatch, expandGap, renderedGaps, type DiffFileContents, type FileExpansion, type RenderedGap } from "./diffContext";
import type { SeparatorAction } from "./DiffContextSeparator";

type Loaded = { state: "loading" } | { state: "ready"; value: DiffFileContents } | { state: "error"; error: string };

export interface DiffContextState {
  /** The patch to draw for `key`: its context spliced in once the texts are here. */
  patchFor(key: string, patch: string): string;
  /** The separators the drawn patch shows (see renderedGaps). */
  gapsFor(key: string, patch: string): RenderedGap[];
  /** A separator's button: reveals lines, fetching the texts first if they are not here yet. */
  expand(key: string, patch: string, gap: number, action: SeparatorAction): void;
  /** True while the texts of `key` are being fetched. */
  loading(key: string): boolean;
  /** Forgets every file (a new scope, thread or whitespace mode). */
  reset(): void;
}

export function createDiffContextState(load: (key: string) => Promise<DiffFileContents>): DiffContextState {
  const contents = signal<Record<string, Loaded>>({});
  const expansion = signal<Record<string, FileExpansion>>({});
  // The patch each key's state was made for: a different patch (a reload changed the file) starts it over.
  const patches = new Map<string, string>();
  let generation = 0;
  const sync = (key: string, patch: string) => {
    const known = patches.get(key);
    if (known === undefined || known === patch) { patches.set(key, patch); return; }
    patches.set(key, patch);
    contents.update((all) => { const next = { ...all }; delete next[key]; return next; });
    expansion.update((all) => { const next = { ...all }; delete next[key]; return next; });
  };
  const ready = (key: string) => { const entry = contents()[key]; return entry?.state === "ready" ? entry.value : null; };
  const fetch = (key: string) => {
    const entry = contents()[key];
    if (entry && entry.state !== "error") return;
    const token = generation;
    contents.update((all) => ({ ...all, [key]: { state: "loading" } }));
    load(key).then(
      (value) => { if (token === generation) contents.update((all) => ({ ...all, [key]: { state: "ready", value } })); },
      (cause) => { if (token === generation) contents.update((all) => ({ ...all, [key]: { state: "error", error: cause instanceof Error ? cause.message : String(cause) } })); },
    );
  };
  return {
    patchFor(key, patch) {
      const value = ready(key);
      const revealed = expansion()[key];
      if (!value || !revealed || patches.get(key) !== patch) return patch;
      return expandFilePatch(patch, value, revealed);
    },
    gapsFor(key, patch) {
      const fresh = patches.get(key) === patch;
      return renderedGaps(patch, fresh ? ready(key) : null, fresh ? (expansion()[key] ?? {}) : {});
    },
    expand(key, patch, gap, action) {
      sync(key, patch);
      expansion.update((all) => ({ ...all, [key]: expandGap(all[key] ?? {}, gap, action === "both" ? "both" : action) }));
      fetch(key);
    },
    loading(key) { return contents()[key]?.state === "loading"; },
    reset() {
      generation++;
      patches.clear();
      contents.set({});
      expansion.set({});
    },
  };
}
