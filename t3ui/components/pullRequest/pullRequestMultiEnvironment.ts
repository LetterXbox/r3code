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
  async function list(payload: unknown, selected?: string): Promise<unknown> {
    const input = record(payload) ?? {};
    const all = targets(selected, input.projectId);
    if (all.length === 0) throw new Error("Connect the selected environment to see pull requests.");
    const cursors = record(input.cursors);
    const calls = all.flatMap((env) => {
      if (!cursors) return [{ env, payload: input }];
      const own: Record<string, string> = {};
      for (const [key, value] of Object.entries(cursors)) {
        if (typeof value !== "string") continue;
        try { const decoded: unknown = JSON.parse(key); if (Array.isArray(decoded) && decoded[0] === env.id && typeof decoded[1] === "string") own[decoded[1]] = value; } catch { /* invalid cursor */ }
      }
      return Object.keys(own).length ? [{ env, payload: { ...input, cursors: own } }] : [];
    });
    const results = await Promise.allSettled(calls.map(({ env, payload: body }) => deps.request(env.id, "pullRequests.list", body)));
    const merged: { entries: unknown[]; errors: unknown[]; nextCursors: Record<string, string>; viewers: Record<string, string>; providers: unknown[]; truncated: boolean } = { entries: [], errors: [], nextCursors: {}, viewers: {}, providers: [], truncated: false };
    let successes = 0;
    results.forEach((result, index) => {
      const env = calls[index]!.env;
      if (result.status === "rejected") { merged.errors.push({ projectTitle: env.label, message: result.reason instanceof Error ? result.reason.message : String(result.reason) }); return; }
      const page = record(result.value);
      if (!page || !Array.isArray(page.entries) || !Array.isArray(page.errors) || !record(page.nextCursors)) { merged.errors.push({ projectTitle: env.label, message: "The server returned an invalid pull request list." }); return; }
      successes++;
      merged.entries.push(...page.entries);
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
    return merged;
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
  return { list, stats, filterOptions, invalidate };
}
