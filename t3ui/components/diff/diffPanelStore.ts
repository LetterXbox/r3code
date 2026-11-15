// diffPanelStore.ts: which diff each thread's Changes panel shows (branch, uncommitted, one commit, one turn, one
// tool call), saved per thread under the reference's key `t3code:diff-panel-state:v1` (byThreadKey and
// branchBaseRefByThreadKey; keepSelectionOnOpenThreadKey is session-only, as the reference's partialize leaves it out).
import { signal, Storage } from "nsh";

export interface ToolCallDiffTarget { threadId: string; itemId: string; revision: string }

export type DiffPanelSelection =
  | ({ kind: "tool-call" } & ToolCallDiffTarget)
  | { kind: "branch"; baseRef: string | null }
  | { kind: "unstaged" }
  | { kind: "commit"; sha: string; baseRef: string | null }
  | { kind: "turn"; turnId: string; filePath: string | null; revealRequestId: number };

export const DIFF_PANEL_STORAGE_KEY = "t3code:diff-panel-state:v1";
const DEFAULT_SELECTION: DiffPanelSelection = { kind: "branch", baseRef: null };

interface State { byThreadKey: Record<string, DiffPanelSelection>; branchBaseRefByThreadKey: Record<string, string | null> }

const state = signal<State>({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
let keepSelectionOnOpenThreadKey: string | null = null;
let loaded = false;

function isSelection(value: unknown): value is DiffPanelSelection {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.kind === "branch") return v.baseRef === null || typeof v.baseRef === "string";
  if (v.kind === "unstaged") return true;
  if (v.kind === "commit") return typeof v.sha === "string" && (v.baseRef === null || typeof v.baseRef === "string");
  if (v.kind === "turn") return typeof v.turnId === "string" && (v.filePath === null || typeof v.filePath === "string") && typeof v.revealRequestId === "number";
  if (v.kind === "tool-call") return typeof v.threadId === "string" && typeof v.itemId === "string" && typeof v.revision === "string";
  return false;
}

/** The saved state (zustand persist's `{ state, version }` envelope), with anything malformed dropped. */
export function readSavedDiffPanelState(text: string | null): State {
  const empty: State = { byThreadKey: {}, branchBaseRefByThreadKey: {} };
  if (!text) return empty;
  try {
    const parsed = JSON.parse(text) as { state?: Record<string, unknown> };
    const saved = parsed?.state ?? {};
    const byThreadKey: Record<string, DiffPanelSelection> = {};
    for (const [key, value] of Object.entries((saved.byThreadKey ?? {}) as Record<string, unknown>)) if (isSelection(value)) byThreadKey[key] = value;
    const branchBaseRefByThreadKey: Record<string, string | null> = {};
    for (const [key, value] of Object.entries((saved.branchBaseRefByThreadKey ?? {}) as Record<string, unknown>)) {
      if (value === null || typeof value === "string") branchBaseRefByThreadKey[key] = value;
    }
    return { byThreadKey, branchBaseRefByThreadKey };
  } catch {
    return empty;
  }
}

void Storage.getItem(DIFF_PANEL_STORAGE_KEY).then((text) => {
  if (loaded) return;
  state.set(readSavedDiffPanelState(text));
}).catch(() => {}).finally(() => { loaded = true; });

function write(next: State) {
  loaded = true;
  state.set(next);
  void Storage.setItem(DIFF_PANEL_STORAGE_KEY, JSON.stringify({ state: next, version: 2 })).catch(() => {});
}

function branchBaseRef(current: State, key: string): string | null {
  const previous = current.byThreadKey[key];
  return previous?.kind === "branch" || previous?.kind === "commit" ? previous.baseRef : (current.branchBaseRefByThreadKey[key] ?? null);
}

/** selectThreadDiffPanelSelection: the thread's selection, the branch diff when it has none. */
export function diffSelectionFor(threadKey: string | null): DiffPanelSelection {
  if (!threadKey) return DEFAULT_SELECTION;
  return state().byThreadKey[threadKey] ?? DEFAULT_SELECTION;
}

export function selectThreadBranchBaseRef(threadKey: string | null): string | null {
  return threadKey ? branchBaseRef(state(), threadKey) : null;
}

export function selectGitScope(threadKey: string, scope: "branch" | "unstaged") {
  const current = state();
  const previous = current.byThreadKey[threadKey];
  const baseRef = branchBaseRef(current, threadKey);
  write({
    byThreadKey: { ...current.byThreadKey, [threadKey]: scope === "branch" ? { kind: "branch", baseRef } : { kind: "unstaged" } },
    branchBaseRefByThreadKey: previous?.kind === "branch" || previous?.kind === "commit"
      ? { ...current.branchBaseRefByThreadKey, [threadKey]: previous.baseRef }
      : current.branchBaseRefByThreadKey,
  });
}

function normalizeBaseRef(baseRef: string | null): string | null {
  const normalized = baseRef?.trim();
  return normalized ? normalized : null;
}

/** The comparison target picker: the branch diff against `baseRef` (null is Automatic), remembered per thread. */
export function selectBranchBaseRef(threadKey: string, baseRef: string | null) {
  const current = state();
  const normalized = normalizeBaseRef(baseRef);
  write({
    byThreadKey: { ...current.byThreadKey, [threadKey]: { kind: "branch", baseRef: normalized } },
    branchBaseRefByThreadKey: { ...current.branchBaseRefByThreadKey, [threadKey]: normalized },
  });
}

export function selectToolCall(threadKey: string, target: ToolCallDiffTarget) {
  const current = state();
  write({ ...current, byThreadKey: { ...current.byThreadKey, [threadKey]: { kind: "tool-call", ...target } } });
}

export function selectTurn(threadKey: string, turnId: string, filePath?: string) {
  const current = state();
  const previous = current.byThreadKey[threadKey];
  write({
    ...current,
    byThreadKey: {
      ...current.byThreadKey,
      [threadKey]: { kind: "turn", turnId, filePath: filePath?.trim() || null, revealRequestId: previous?.kind === "turn" ? previous.revealRequestId + 1 : 1 },
    },
  });
}

export function selectCommit(threadKey: string, sha: string, keepOnOpen = false) {
  const current = state();
  const baseRef = branchBaseRef(current, threadKey);
  if (keepOnOpen) keepSelectionOnOpenThreadKey = threadKey;
  write({
    byThreadKey: { ...current.byThreadKey, [threadKey]: { kind: "commit", sha, baseRef } },
    branchBaseRefByThreadKey: { ...current.branchBaseRefByThreadKey, [threadKey]: baseRef },
  });
}

export function consumeKeepSelectionOnOpen(threadKey: string): boolean {
  if (keepSelectionOnOpenThreadKey !== threadKey) return false;
  keepSelectionOnOpenThreadKey = null;
  return true;
}

/** An entry point (a turn's "Open diff", a tool call's "View diff") is opening the panel on its own selection. */
let explicitDiffOpenThreadKey: string | null = null;
export function noteExplicitDiffOpen(threadKey: string) { explicitDiffOpenThreadKey = threadKey; }

/** ChatView's open effect: the diff opening (or the thread changing while open) without an explicit request,
 * and without a link's keepSelectionOnOpen, resets the thread to the branch scope. */
export function applyDiffOpenSelection(threadKey: string) {
  const explicit = explicitDiffOpenThreadKey;
  explicitDiffOpenThreadKey = null;
  if (explicit === threadKey || consumeKeepSelectionOnOpen(threadKey)) return;
  selectGitScope(threadKey, "branch");
}

// useDiffPanelSessionStore: session-only so folds survive right-panel switches without changing reload defaults.
const collapsedFileKeysByScopeKey = signal<Record<string, ReadonlySet<string>>>({});
const EMPTY_KEYS: ReadonlySet<string> = new Set();
export function collapsedFileKeysFor(scopeKey: string, defaults: ReadonlySet<string> = EMPTY_KEYS): ReadonlySet<string> {
  return collapsedFileKeysByScopeKey()[scopeKey] ?? defaults;
}
export function updateCollapsedFileKeys(scopeKey: string, update: (current: ReadonlySet<string>) => ReadonlySet<string>, defaults: ReadonlySet<string> = EMPTY_KEYS) {
  const all = collapsedFileKeysByScopeKey();
  const current = all[scopeKey] ?? defaults;
  const next = update(current);
  if (next === current) return;
  collapsedFileKeysByScopeKey.set({ ...all, [scopeKey]: next });
}

/** A selected turn that no longer exists moves to the latest one (availableTurnIds is newest first). */
export function reconcileTurnSelection(threadKey: string, availableTurnIds: readonly string[]) {
  const current = state();
  const previous = current.byThreadKey[threadKey];
  const latest = availableTurnIds[0];
  if (previous?.kind !== "turn" || latest === undefined || availableTurnIds.includes(previous.turnId)) return;
  write({ ...current, byThreadKey: { ...current.byThreadKey, [threadKey]: { ...previous, turnId: latest } } });
}

export function removeDiffThread(threadKey: string) {
  const current = state();
  if (!(threadKey in current.byThreadKey) && !(threadKey in current.branchBaseRefByThreadKey)) return;
  const { [threadKey]: _removed, ...byThreadKey } = current.byThreadKey;
  const { [threadKey]: _removedBase, ...branchBaseRefByThreadKey } = current.branchBaseRefByThreadKey;
  write({ byThreadKey, branchBaseRefByThreadKey });
}

/** Tests start from a clean store. */
export function resetDiffPanelStoreForTests() { loaded = true; keepSelectionOnOpenThreadKey = null; explicitDiffOpenThreadKey = null; collapsedFileKeysByScopeKey.set({}); state.set({ byThreadKey: {}, branchBaseRefByThreadKey: {} }); }

// ---- Turns (useThreadCheckpointSummaries / deriveThreadCheckpointSummaries) ----

export interface TurnDiffSummary { runId: string; checkpointTurnCount: number; completedAt: string }

/** The thread's checkpoints with a run and an ordinal, newest first (checkpointTurnCount, then completedAt, descending). */
export function turnDiffSummaries(checkpoints: readonly Record<string, unknown>[]): TurnDiffSummary[] {
  const out: TurnDiffSummary[] = [];
  for (const checkpoint of checkpoints) {
    const ordinal = checkpoint.appRunOrdinal;
    const runId = checkpoint.runId;
    if (typeof ordinal !== "number" || typeof runId !== "string") continue;
    const captured = checkpoint.capturedAt;
    out.push({ runId, checkpointTurnCount: ordinal, completedAt: typeof captured === "string" ? captured : "" });
  }
  return out.sort((a, b) => (a.checkpointTurnCount !== b.checkpointTurnCount ? b.checkpointTurnCount - a.checkpointTurnCount : b.completedAt.localeCompare(a.completedAt)));
}

/** resolveToolCallDiffTarget (diffPanelStore.ts): the live file_change item's detail revision replaces the stored one. */
export function liveToolCallRevision(target: { threadId: string; itemId: string }, items: ReadonlyArray<Record<string, unknown>>, revisionOf: (item: Record<string, unknown>) => string): string | null {
  const item = items.find((row) => row.id === target.itemId && (typeof row.threadId !== "string" || row.threadId === target.threadId));
  return item && item.type === "file_change" ? revisionOf(item) : null;
}
