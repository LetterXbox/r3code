// baseRefChoices.ts: the Changes panel's comparison-target list (lib/baseRefChoices.ts): local branches paired with
// their remote (origin first), then remote-only branches, from two vcs.listRefs answers.
export interface BaseVcsRef { name: string; remoteName?: string }

export interface BaseRefChoice { id: string; label: string; local: BaseVcsRef | null; remote: BaseVcsRef | null }

/** A vcs.listRefs answer's refs (VcsRef: name, remoteName), anything malformed dropped. */
export function parseBaseRefs(value: unknown): BaseVcsRef[] {
  const refs = (value && typeof value === "object" ? (value as { refs?: unknown }).refs : null);
  if (!Array.isArray(refs)) return [];
  return refs.flatMap((item): BaseVcsRef[] => {
    const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    if (typeof entry.name !== "string" || !entry.name.trim()) return [];
    return [typeof entry.remoteName === "string" && entry.remoteName ? { name: entry.name, remoteName: entry.remoteName } : { name: entry.name }];
  });
}

function remoteBranchName(ref: BaseVcsRef): string {
  if (ref.remoteName && ref.name.startsWith(`${ref.remoteName}/`)) return ref.name.slice(ref.remoteName.length + 1);
  return ref.name;
}

export function buildBaseRefChoices(localRefs: readonly BaseVcsRef[], remoteRefs: readonly BaseVcsRef[]): BaseRefChoice[] {
  const unused = new Set(remoteRefs);
  const paired = localRefs.map((local) => {
    const matches = remoteRefs.filter((remote) => unused.has(remote) && remoteBranchName(remote) === local.name);
    const remote = matches.find((candidate) => candidate.remoteName === "origin") ?? matches[0] ?? null;
    if (remote) unused.delete(remote);
    return { id: `local:${local.name}`, label: local.name, local, remote };
  });
  const remoteOnly = remoteRefs.filter((remote) => unused.has(remote)).map((remote) => ({ id: `remote:${remote.name}`, label: remote.name, local: null, remote }));
  return [...paired, ...remoteOnly];
}

export function filterBaseRefChoices(choices: readonly BaseRefChoice[], query: string): BaseRefChoice[] {
  const q = query.trim().toLocaleLowerCase();
  if (q.length === 0) return [...choices];
  return choices.filter((choice) => choice.label.toLocaleLowerCase().includes(q)
    || choice.local?.name.toLocaleLowerCase().includes(q) === true
    || choice.remote?.name.toLocaleLowerCase().includes(q) === true);
}

/** The ref a choice selects: the remote one when that is what is selected, else the local, else the remote. */
export function valueForBaseRefChoice(choice: BaseRefChoice, selectedBaseRef: string | null): string {
  return selectedBaseRef && selectedBaseRef === choice.remote?.name ? selectedBaseRef : (choice.local?.name ?? choice.remote?.name ?? choice.id);
}
