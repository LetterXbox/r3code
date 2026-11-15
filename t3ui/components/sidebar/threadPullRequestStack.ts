// The pull request badge of a thread row when the thread has several links (packages/source-control-core
// shared/threadPullRequests.ts: resolveThreadPullRequestChains and resolveThreadPullRequestBadge, and
// ThreadStatusIndicators.tsx's resolveThreadPullRequestBadgePresentation). One chain of several links reads as
// "Stack of N"; other links read as "+N" with the overall state. Pure, so it is tested without an engine.

export type BadgeState = "open" | "draft" | "merged" | "closed";

/** The slice of a thread's pull request link the badge reads. */
export interface BadgeLink {
  host: string;
  repository: string;
  number: number;
  url?: string;
  source?: string;
  linkedAt?: string;
  snapshot: { state: string; isDraft: boolean; headBranch: string; baseBranch: string; updatedAt?: string | null } | null;
  /** A native stack: the layers the host reports, shared by its members through `id`. */
  stack: { id: string; layers: readonly { number: number }[] } | null;
}

export type ThreadPullRequestStackBadge =
  | { kind: "stack"; layers: number; state: BadgeState }
  | { kind: "pull-request"; others: number; state: BadgeState };

const keyOf = (link: Pick<BadgeLink, "host" | "repository" | "number">) => `${link.host.trim().toLowerCase()}/${link.repository.trim().toLowerCase()}#${link.number}`;
const repoOf = (link: Pick<BadgeLink, "host" | "repository">) => `${link.host.trim().toLowerCase()}/${link.repository.trim().toLowerCase()}`;

/** visibleThreadPullRequests: a link the user dismissed from a stack is hidden. */
export const visibleLinks = <T extends { source?: string }>(links: readonly T[]): T[] => links.filter((link) => link.source !== "stack-dismissed");

export interface BadgeChain { layers: BadgeLink[]; depths: number[] }

/**
 * resolveThreadPullRequestChains: native stacks group by the host's stack id (in the host's layer order); the rest chain
 * through branches (a pull request whose base branch is another one's head branch sits above it, one level deeper).
 */
export function resolveChains(links: readonly BadgeLink[]): BadgeChain[] {
  const visible = visibleLinks(links);
  const chains: BadgeChain[] = [];
  const placed = new Set<string>();
  const native = new Map<string, BadgeLink[]>();
  for (const link of visible) {
    if (link.stack === null) continue;
    const id = `${repoOf(link)}#stack:${link.stack.id}`;
    native.set(id, [...(native.get(id) ?? []), link]);
  }
  for (const members of native.values()) {
    const order = new Map(members[0]!.stack!.layers.map((layer, index) => [layer.number, index]));
    const sorted = [...members].sort((left, right) => (order.get(left.number) ?? order.size) - (order.get(right.number) ?? order.size));
    for (const member of sorted) placed.add(keyOf(member));
    chains.push({ layers: sorted, depths: sorted.map((_, index) => index) });
  }
  const remaining = visible.filter((link) => !placed.has(keyOf(link)));
  const branchKey = (link: BadgeLink, branch: string) => `${repoOf(link)}:${branch}`;
  const byHead = new Map<string, BadgeLink | null>();
  for (const link of remaining) {
    if (link.snapshot === null) continue;
    const key = branchKey(link, link.snapshot.headBranch);
    byHead.set(key, byHead.has(key) ? null : link);
  }
  const parentOf = (link: BadgeLink) => {
    if (link.snapshot === null) return undefined;
    const parent = byHead.get(branchKey(link, link.snapshot.baseBranch));
    return parent == null || parent === link ? undefined : parent;
  };
  const children = new Map<string, BadgeLink[]>();
  for (const link of remaining) {
    const parent = parentOf(link);
    if (parent === undefined) continue;
    children.set(keyOf(parent), [...(children.get(keyOf(parent)) ?? []), link]);
  }
  for (const base of remaining) {
    if (parentOf(base) !== undefined) continue;
    const layers: BadgeLink[] = [];
    const depths: number[] = [];
    const pending: { link: BadgeLink; depth: number }[] = [{ link: base, depth: 0 }];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      // Two links with one identity would otherwise share a child list and expand forever.
      if (placed.has(keyOf(next.link))) continue;
      placed.add(keyOf(next.link));
      layers.push(next.link);
      depths.push(next.depth);
      const below = children.get(keyOf(next.link)) ?? [];
      for (let index = below.length - 1; index >= 0; index -= 1) pending.push({ link: below[index]!, depth: next.depth + 1 });
    }
    if (layers.length > 0) chains.push({ layers, depths });
  }
  for (const link of remaining) if (!placed.has(keyOf(link))) chains.push({ layers: [link], depths: [0] });
  return chains;
}

export const pullRequestChainSizes = (links: readonly BadgeLink[]): number[] => resolveChains(links).map((chain) => chain.layers.length);

const isOpen = (link: BadgeLink) => link.snapshot === null || link.snapshot.state === "open";
const updatedAtOf = (link: BadgeLink) => { const ms = Date.parse(link.snapshot?.updatedAt ?? link.linkedAt ?? ""); return Number.isNaN(ms) ? 0 : ms; };
const layersFromTop = (chain: BadgeChain): BadgeLink[] => chain.layers
  .map((link, index) => ({ link, index, depth: chain.depths[index]! }))
  .sort((left, right) => right.depth - left.depth || right.index - left.index)
  .map((entry) => entry.link);

/**
 * resolveThreadCurrentPullRequestLink: the one open link; with several open ones the top of the open stack (the newest
 * stack when there are several); with none open the top of the only chain, else the most recently updated link.
 */
export function resolveCurrentLink(links: readonly BadgeLink[]): BadgeLink | null {
  const visible = visibleLinks(links);
  if (visible.length === 0) return null;
  const open = visible.filter(isOpen);
  if (open.length === 1) return open[0]!;
  const chains = resolveChains(visible);
  if (open.length > 1) {
    const openChains = chains.map((chain) => layersFromTop(chain).filter(isOpen)).filter((layers) => layers.length > 0);
    const ordered = openChains.length === 1
      ? openChains[0]!
      : openChains
        .map((layers) => ({ layers, newest: Math.max(...layers.map((link) => Date.parse(link.linkedAt ?? "") || 0)) }))
        .sort((left, right) => right.newest - left.newest)
        .flatMap((chain) => chain.layers);
    return ordered[0]!;
  }
  if (chains.length === 1) return layersFromTop(chains[0]!)[0]!;
  let latest = visible[0]!;
  for (const link of visible.slice(1)) if (updatedAtOf(link) > updatedAtOf(latest)) latest = link;
  return latest;
}

/** pullRequestListLines' order: chains newest first (by their most recently updated layer), each in its layer order. */
export function pullRequestListOrder<T extends BadgeLink>(links: readonly T[]): T[] {
  const latest = (link: BadgeLink) => { const ms = Date.parse(link.snapshot?.updatedAt ?? link.linkedAt ?? ""); return Number.isNaN(ms) ? 0 : ms; };
  return [...resolveChains(links)]
    .sort((left, right) => Math.max(...right.layers.map(latest)) - Math.max(...left.layers.map(latest)))
    .flatMap((chain) => chain.layers) as T[];
}

/** resolveThreadPullRequestBadge: the overall state of the visible links, and whether they form one stack. */
export function resolveThreadPullRequestBadge(links: readonly BadgeLink[]): ThreadPullRequestStackBadge | null {
  const visible = visibleLinks(links);
  if (visible.length === 0) return null;
  const states = visible.map((link) => link.snapshot?.state ?? "open");
  const state: BadgeState = visible.every((link) => link.snapshot?.state === "open" && link.snapshot.isDraft)
    ? "draft"
    : states.includes("open") ? "open" : states.every((entry) => entry === "merged") ? "merged" : "closed";
  if (visible.length > 1 && pullRequestChainSizes(visible).length === 1) return { kind: "stack", layers: visible.length, state };
  return { kind: "pull-request", others: visible.length - 1, state };
}

/** A shell link record as the badge reads it; null when it names no pull request. */
export function badgeLinkFromShell(raw: unknown): BadgeLink | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const link = raw as Record<string, unknown>;
  if (typeof link.number !== "number") return null;
  const snapshot = typeof link.snapshot === "object" && link.snapshot !== null ? (link.snapshot as Record<string, unknown>) : null;
  const stack = typeof link.stack === "object" && link.stack !== null ? (link.stack as Record<string, unknown>) : null;
  return {
    host: typeof link.host === "string" ? link.host : "",
    repository: typeof link.repository === "string" ? link.repository : "",
    number: link.number,
    ...(typeof link.url === "string" ? { url: link.url } : {}),
    ...(typeof link.source === "string" ? { source: link.source } : {}),
    ...(typeof link.linkedAt === "string" ? { linkedAt: link.linkedAt } : {}),
    snapshot: snapshot && typeof snapshot.state === "string"
      ? { state: snapshot.state, isDraft: snapshot.isDraft === true, headBranch: typeof snapshot.headBranch === "string" ? snapshot.headBranch : "", baseBranch: typeof snapshot.baseBranch === "string" ? snapshot.baseBranch : "", updatedAt: typeof snapshot.updatedAt === "string" ? snapshot.updatedAt : null }
      : null,
    stack: stack && typeof stack.id === "string" ? { id: stack.id, layers: Array.isArray(stack.layers) ? stack.layers.flatMap((layer) => (typeof layer === "object" && layer !== null && typeof (layer as { number?: unknown }).number === "number" ? [{ number: (layer as { number: number }).number }] : [])) : [] } : null,
  };
}

/** The row's badge from the shell's links: null while a lone link keeps the row's single-badge look. */
export function stackBadgeFromShell(value: Record<string, unknown>): ThreadPullRequestStackBadge | null {
  const links = Array.isArray(value.pullRequests) ? value.pullRequests.flatMap((raw) => { const link = badgeLinkFromShell(raw); return link ? [link] : []; }) : [];
  const badge = resolveThreadPullRequestBadge(links);
  return badge && (badge.kind === "stack" || badge.others > 0) ? badge : null;
}

/** The terminology of a host's change requests (changeRequestTerminologyForUrl): GitLab says merge request. */
export function changeRequestWords(url: string | undefined): { shortLabel: string; plural: string } {
  const gitlab = url !== undefined && /gitlab/i.test(url) && /\/merge_requests\//.test(url);
  return gitlab ? { shortLabel: "MR", plural: "merge requests" } : { shortLabel: "PR", plural: "pull requests" };
}

const STATE_LABEL: Record<BadgeState, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };

/** The glyph's text, accessibility label and the state that tints it, for a stack or a multi-link badge. */
export function stackBadgePresentation(badge: ThreadPullRequestStackBadge, input: { number: number; url: string; singleLabel: string }): { text: string; label: string; state: BadgeState; glyph: "layers" | "state" } {
  const words = changeRequestWords(input.url);
  const overall = STATE_LABEL[badge.state].toLowerCase();
  if (badge.kind === "stack") return { text: String(badge.layers), label: `Stack of ${badge.layers} ${words.plural}, ${overall}`, state: badge.state, glyph: "layers" };
  return { text: `+${badge.others + 1}`, label: `${input.singleLabel}, and ${badge.others} more linked; overall ${overall}`, state: badge.state, glyph: "state" };
}
