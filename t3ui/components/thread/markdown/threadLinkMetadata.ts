// orchestration.ts threadLinkMetadata (client-runtime) for ThreadContextChip.tsx / MarkdownThreadLink.tsx: a thread link
// whose thread is not in the shell (archived, or not loaded) asks the server for its title and project. A server that
// advertises `threadLinkMetadata` answers `orchestration.getThreadLinkMetadata`; an older one only knows
// `orchestration.getThreadTitles`, whose titles come back with `projectId: null`. Deleted and unknown ids are absent.
import { signal } from "nsh";
import { backendConnectionGeneration, requestBackend } from "../../../store";

export interface ThreadLinkMetadata { title: string; projectId: string | null }
/** pending: asked, no answer yet; missing: the server answered without this id (or the lookup failed). */
export type ThreadLinkLookup = { state: "pending" } | { state: "found"; metadata: ThreadLinkMetadata } | { state: "missing" };

type Request = (method: string, payload: unknown) => Promise<unknown>;

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" ? (value as Record<string, unknown>) : null);

/** The answer of either method, as the reference maps it. */
export function readThreadLinkMetadata(value: unknown, fromTitles: boolean): Record<string, ThreadLinkMetadata> {
  const r = record(value);
  if (!r) return {};
  const out: Record<string, ThreadLinkMetadata> = {};
  for (const [id, entry] of Object.entries(r)) {
    if (fromTitles) { if (typeof entry === "string") out[id] = { title: entry, projectId: null }; continue; }
    const e = record(entry);
    if (e && typeof e.title === "string") out[id] = { title: e.title, projectId: typeof e.projectId === "string" ? e.projectId : null };
  }
  return out;
}

export async function fetchThreadLinkMetadata(threadIds: readonly string[], request: Request = requestBackend): Promise<Record<string, ThreadLinkMetadata>> {
  const config = record(await request("server.getConfig", {}));
  if (config?.threadLinkMetadata === true) return readThreadLinkMetadata(await request("orchestration.getThreadLinkMetadata", { threadIds }), false);
  return readThreadLinkMetadata(await request("orchestration.getThreadTitles", { threadIds }), true);
}

// One answer per thread id and connection (useEnvironmentQuery keeps the query while a chip shows it).
const lookups = signal<Readonly<Record<string, ThreadLinkLookup>>>({});
let lookupGeneration = -1;
const asked = new Set<string>();

/** The lookup for `threadId`, started on first read. Call only for a thread the shell does not hold. */
export function threadLinkLookup(threadId: string, request: Request = requestBackend): ThreadLinkLookup {
  const generation = backendConnectionGeneration();
  if (generation !== lookupGeneration) { lookupGeneration = generation; asked.clear(); queueMicrotask(() => lookups.set({})); }
  const known = lookups()[threadId];
  if (known) return known;
  if (asked.has(threadId)) return { state: "pending" };
  asked.add(threadId);
  const set = (value: ThreadLinkLookup) => { if (lookupGeneration === generation) lookups.set({ ...lookups(), [threadId]: value }); };
  queueMicrotask(() => {
    void fetchThreadLinkMetadata([threadId], request)
      .then((found) => set(found[threadId] ? { state: "found", metadata: found[threadId]! } : { state: "missing" }))
      .catch(() => set({ state: "missing" }));
  });
  return { state: "pending" };
}

export function resetThreadLinkLookupsForTest() { lookups.set({}); asked.clear(); lookupGeneration = -1; }
