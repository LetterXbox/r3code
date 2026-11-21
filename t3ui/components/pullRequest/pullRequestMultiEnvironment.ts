/** Fan out list-level queries without mixing project ids or pagination cursors between servers. */
export interface PullRequestEnvironmentTarget { id: string; label: string; connected: boolean }
type Request = (environmentId: string, method: string, payload: unknown) => Promise<unknown>;
type Dict = Record<string, unknown>;
const record = (value: unknown): Dict | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Dict : null;
const cursorKey = (environmentId: string, key: string) => JSON.stringify([environmentId, key]);
export const projectViewerKey = (projectId: string, host: string) => JSON.stringify([projectId, host]);

export function createPullRequestMultiEnvironment(deps: {
  environments: () => readonly PullRequestEnvironmentTarget[];
  request: Request;
  environmentForProject: (projectId: string) => string;
}) {
  const targets = (selected: string | undefined, projectId: unknown) => {
    const projectEnvironment = typeof projectId === "string" ? deps.environmentForProject(projectId) : undefined;
    return deps.environments().filter((env) => env.connected && (!selected || env.id === selected) && (!projectEnvironment || env.id === projectEnvironment));
  };
  type EnvSlot = { status: "pending" | "loaded" | "failed"; value?: unknown; error?: string; promise?: Promise<void> };
  const slotsByScope = new Map<string, Map<string, EnvSlot>>();

  function buildCalls(input: Dict, selected: string | undefined) {
    const all = targets(selected, input.projectId);
    if (all.length === 0) throw new Error("Connect the selected environment to see pull requests.");
    const cursors = record(input.cursors);
    return all.flatMap((env) => {
      if (!cursors) return [{ env, payload: input }];
      const own: Record<string, string> = {};
      for (const [key, value] of Object.entries(cursors)) {
        if (typeof value !== "string") continue;
        try { const decoded: unknown = JSON.parse(key); if (Array.isArray(decoded) && decoded[0] === env.id && typeof decoded[1] === "string") own[decoded[1]] = value; } catch { /* invalid cursor */ }
      }
      return Object.keys(own).length ? [{ env, payload: { ...input, cursors: own } }] : [];
    });
  }

  function mergeResults(calls: { env: PullRequestEnvironmentTarget }[], outcomes: PromiseSettledResult<unknown>[]): unknown {
    const merged: { entries: unknown[]; errors: unknown[]; nextCursors: Record<string, string>; viewers: Record<string, string>; providers: unknown[]; truncated: boolean } = { entries: [], errors: [], nextCursors: {}, viewers: {}, providers: [], truncated: false };
    const byUrl = new Map<string, { entry: Dict; environmentId: string }>();
    let successes = 0;
    outcomes.forEach((result, index) => {
      const env = calls[index]!.env;
      if (result.status === "rejected") { merged.errors.push({ projectTitle: env.label, message: result.reason instanceof Error ? result.reason.message : String(result.reason) }); return; }
      const page = record(result.value);
      if (!page || !Array.isArray(page.entries) || !Array.isArray(page.errors) || !record(page.nextCursors)) { merged.errors.push({ projectTitle: env.label, message: "The server returned an invalid pull request list." }); return; }
      successes++;
      for (const raw of page.entries) {
        const entry = record(raw);
        if (!entry || typeof entry.url !== "string" || entry.url.length === 0) continue;
        const held = byUrl.get(entry.url);
        const updatedAt = typeof entry.updatedAt === "string" ? entry.updatedAt : "";
        const heldUpdatedAt = typeof held?.entry.updatedAt === "string" ? held.entry.updatedAt : "";
        if (!held || (held.environmentId === env.id && updatedAt > heldUpdatedAt)) {
          byUrl.set(entry.url, { entry, environmentId: env.id });
        }
      }
      merged.errors.push(...page.errors);
      merged.providers.push(...(Array.isArray(page.providers) ? page.providers : []));
      merged.truncated ||= page.truncated === true;
      for (const [key, value] of Object.entries(record(page.nextCursors)!)) if (typeof value === "string") merged.nextCursors[cursorKey(env.id, key)] = value;
      const viewers = record(page.viewers) ?? {};
      for (const [host, viewer] of Object.entries(viewers)) if (typeof viewer === "string") {
        for (const raw of page.entries) { const entry = record(raw); if (entry && typeof entry.projectId === "string" && entry.host === host) merged.viewers[projectViewerKey(entry.projectId, host)] = viewer; }
      }
    });
    if (calls.length > 0 && successes === 0) throw new Error(merged.errors.map((item) => { const error = record(item); return `${error?.projectTitle}: ${error?.message}`; }).join("; "));
    merged.entries = [...byUrl.values()].map(({ entry }) => entry);
    return merged;
  }

  async function runList(payload: unknown, selected: string | undefined, retryFailedOnly: boolean): Promise<unknown> {
    const input = record(payload) ?? {};
    const calls = buildCalls(input, selected);
    const scopeKey = record(input.cursors) ? null : JSON.stringify([selected ?? null, input]);
    let scopeSlots = scopeKey ? slotsByScope.get(scopeKey) : undefined;
    if (scopeKey && !scopeSlots) {
      scopeSlots = new Map();
      slotsByScope.set(scopeKey, scopeSlots);
    }
    const fetchSlot = (env: PullRequestEnvironmentTarget, body: Dict): Promise<PromiseSettledResult<unknown>> => {
      if (scopeSlots) {
        const current = scopeSlots.get(env.id);
        if (retryFailedOnly && current?.status === "loaded") {
          return Promise.resolve({ status: "fulfilled", value: current.value });
        }
        if (retryFailedOnly && current?.status === "pending" && current.promise) {
          return current.promise.then(() => {
            const settled = scopeSlots!.get(env.id);
            return settled?.status === "loaded"
              ? { status: "fulfilled", value: settled.value }
              : { status: "rejected", reason: new Error(settled?.error ?? "Unknown error") };
          });
        }
      }
      const slot: EnvSlot = { status: "pending" };
      const req = deps.request(env.id, "pullRequests.list", body);
      const tracked = req.then((value) => {
        const page = record(value);
        if (!page || !Array.isArray(page.entries) || !Array.isArray(page.errors) || !record(page.nextCursors)) {
          slot.status = "failed";
          slot.error = "The server returned an invalid pull request list.";
        } else {
          slot.status = "loaded";
          slot.value = value;
        }
      }, (cause) => {
        slot.status = "failed";
        slot.error = cause instanceof Error ? cause.message : String(cause);
      });
      slot.promise = tracked;
      if (scopeSlots) scopeSlots.set(env.id, slot);
      return req.then((value) => ({ status: "fulfilled" as const, value }), (reason) => ({ status: "rejected" as const, reason }));
    };
    const outcomes = await Promise.all(calls.map(({ env, payload: body }) => fetchSlot(env, body)));
    return mergeResults(calls, outcomes);
  }

  async function list(payload: unknown, selected?: string): Promise<unknown> {
    return runList(payload, selected, false);
  }

  /** Retry only refetches environments whose last list failed, leaving healthy or pending ones untouched (#39536). */
  async function retry(payload: unknown, selected?: string): Promise<unknown> {
    return runList(payload, selected, true);
  }
  async function stats(payload: unknown): Promise<unknown> {
    const refs = record(payload)?.refs;
    if (!Array.isArray(refs)) return { stats: [] };
    const groups = new Map<string, unknown[]>();
    for (const ref of refs) { const projectId = record(ref)?.projectId; if (typeof projectId !== "string") continue; const id = deps.environmentForProject(projectId); groups.set(id, [...(groups.get(id) ?? []), ref]); }
    const batches = [...groups];
    const answers = await Promise.allSettled(batches.map(async ([id, own]) => deps.request(id, "pullRequests.listStats", { refs: own })));
    const failedProjects: string[] = [];
    const stats = answers.flatMap((answer, index) => {
      if (answer.status === "rejected") { for (const ref of batches[index]![1]) { const projectId = record(ref)?.projectId; if (typeof projectId === "string") failedProjects.push(projectId); } return []; }
      const value = record(answer.value)?.stats;
      return Array.isArray(value) ? value : [];
    });
    return { stats, failedProjects };
  }
  async function filterOptions(payload: unknown, selected?: string): Promise<unknown> {
    const input = record(payload) ?? {};
    const all = targets(selected, input.projectId);
    if (all.length === 0) throw new Error("Connect the selected environment to search filters.");
    const answers = await Promise.allSettled(all.map((env) => deps.request(env.id, "pullRequests.filterOptions", input)));
    const values = answers.flatMap((answer) => answer.status === "fulfilled" ? [record(answer.value)] : []);
    if (!values.length) throw new Error("Could not search filter options on any environment.");
    return { authors: values.flatMap((value) => Array.isArray(value?.authors) ? value.authors : []), labels: values.flatMap((value) => Array.isArray(value?.labels) ? value.labels : []) };
  }
  async function invalidate(selected?: string): Promise<void> {
    await Promise.allSettled(targets(selected, undefined).map((env) => deps.request(env.id, "pullRequests.invalidate", {})));
  }
  return { list, retry, stats, filterOptions, invalidate };
}
