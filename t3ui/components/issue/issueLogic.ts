// Issue tracking core types, parsers, presentation, selection, and URL resolution (#19259, #19274, #37760, #38854, #39809).
import { pullRequestLabelColor } from "../pullRequest/pullRequestPresentation";

export type IssueStateCategory = "open" | "closed";
export type IssueListState = "all" | "open" | "closed";
export type IssueInvolvement = "all" | "assigned" | "authored" | "mentioned";
export type IssueListSort = "updated" | "created";
export type IssueEventKind = "closed" | "reopened" | "labeled" | "unlabeled" | "assigned" | "unassigned" | "renamed" | "referenced" | "state-changed";

export interface IssueActor { login: string; name: string | null; avatarUrl: string | null; isBot?: boolean | null }
export interface IssueLabel { name: string; color: string | null; description?: string | null }
export interface IssueState { category: IssueStateCategory; name: string; closeReason?: string | null }
export interface IssueReaction { content: string; count: number; viewerReacted: boolean }

export interface IssueRef {
  projectId: string;
  tracker: string;
  host?: string;
  scope: string;
  key: string;
}

export interface IssueScopeRef {
  projectId: string;
  tracker: string;
  host?: string;
  scope: string;
}

export interface IssueListEntry {
  tracker: string;
  host: string;
  scope: string;
  key: string;
  displayKey: string;
  title: string;
  url: string;
  author: IssueActor | null;
  state: IssueState;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  assignees: IssueActor[];
  labels: IssueLabel[];
  commentCount: number;
  projectId: string;
  projectTitle: string;
}

export interface EnvironmentIssueEntry extends IssueListEntry {
  environmentId: string;
}

export interface IssueCapabilities {
  create: boolean;
  edit: boolean;
  comment: boolean;
  labels: boolean;
  assignees: boolean;
  reactions: boolean;
  templates: boolean;
  linkedPullRequests: boolean;
  events: boolean;
  search: boolean;
}

export interface IssueTrackerSummary {
  tracker: string;
  host: string;
  projectCount: number;
  capabilities: IssueCapabilities | null;
  configured: boolean;
  detail: string | null;
}

export interface IssueListProjectError {
  projectId: string;
  projectTitle: string;
  message: string;
}

export interface IssueListResult {
  viewers: Record<string, string>;
  trackers: IssueTrackerSummary[];
  entries: IssueListEntry[];
  errors: IssueListProjectError[];
  nextCursors: Record<string, string>;
  scopes?: IssueScopeRef[];
}

export interface IssueComment {
  id: string;
  author: IssueActor | null;
  body: string;
  createdAt: string;
  url: string | null;
  reactions?: IssueReaction[];
}

export interface IssueEvent {
  id: string;
  kind: IssueEventKind;
  actor: IssueActor | null;
  createdAt: string;
  detail: string | null;
}

export interface IssueLinkedPullRequest {
  repository: string;
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  closesIssue: boolean;
}

export interface IssueViewerPermissions {
  setState: boolean;
  comment: boolean;
  edit: boolean;
  labels: boolean;
  assignees: boolean;
}

export interface IssueDetail extends IssueListEntry {
  writable: boolean;
  capabilities: IssueCapabilities;
  viewerPermissions: IssueViewerPermissions;
  states: IssueState[];
  viewer: string | null;
  body: string;
  reactions?: IssueReaction[];
  comments: IssueComment[];
  commentsCursor: string | null;
  events: IssueEvent[];
  linkedPullRequests: IssueLinkedPullRequest[];
}

export interface IssueLabelCandidate extends IssueLabel {
  description: string | null;
}

export interface IssueAssigneeCandidate extends IssueActor {
  id: string;
}

export interface IssueCandidates {
  labels: IssueLabelCandidate[];
  assignees: IssueAssigneeCandidate[];
  truncated: boolean;
}

export interface IssueLinkedThread {
  id: string;
  projectId: string;
  title: string;
  archivedAt: string | null;
  settled: boolean;
}

export interface IssueTrackerConnection {
  tracker: string;
  displayName: string;
  scopeNoun: string;
  credential: { label: string; helpUrl: string | null };
  connected: boolean;
  account: string | null;
  workspace?: string | null;
  detail: string | null;
  scopes: { key: string; name: string }[];
}

export interface IssueTrackerConnectionList {
  trackers: IssueTrackerConnection[];
  bindings: Record<string, { tracker: string; scope: string }>;
}

export interface ThreadIssueLink {
  tracker: string;
  host: string;
  scope: string;
  key: string;
  projectId: string;
  url: string;
  source: string;
  linkedAt: string;
  displayKey: string;
  title: string;
}

const dict = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const optStr = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const num = (value: unknown, fallback = 0): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

export const LINEAR_KIND = "linear";
export const LINEAR_HOST = "linear.app";

const trackerCache = new Map<string, IssueTrackerConnectionList>();
export function replaceIssueTrackersSnapshot(environmentId: string, data: IssueTrackerConnectionList) {
  trackerCache.set(environmentId, data);
}
export function cachedIssueTrackersSnapshot(environmentId: string): IssueTrackerConnectionList | undefined {
  return trackerCache.get(environmentId);
}

export function threadIssueKeyOf(key: Pick<ThreadIssueLink, "tracker" | "host" | "scope" | "key">): string {
  return `${key.tracker}\u0000${key.host.trim().toLowerCase()}\u0000${key.scope.trim().toLowerCase()}\u0000${key.key.trim()}`;
}

export function environmentIssueKey(environmentId: string, key: Pick<ThreadIssueLink, "tracker" | "host" | "scope" | "key">): string {
  return `${environmentId}\u0000${threadIssueKeyOf(key)}`;
}

export function threadIssueKeysEqual(
  left: Pick<ThreadIssueLink, "tracker" | "host" | "scope" | "key">,
  right: Pick<ThreadIssueLink, "tracker" | "host" | "scope" | "key">,
): boolean {
  return threadIssueKeyOf(left) === threadIssueKeyOf(right);
}

function parseActor(raw: unknown): IssueActor | null {
  const o = dict(raw);
  if (!o || typeof o.login !== "string" || !o.login) return null;
  return { login: o.login, name: optStr(o.name), avatarUrl: optStr(o.avatarUrl), isBot: typeof o.isBot === "boolean" ? o.isBot : null };
}

function parseLabel(raw: unknown): IssueLabel | null {
  const o = dict(raw);
  if (!o || typeof o.name !== "string" || !o.name) return null;
  return { name: o.name, color: optStr(o.color), description: optStr(o.description) };
}

function parseState(raw: unknown): IssueState {
  const o = dict(raw) ?? {};
  return { category: o.category === "closed" ? "closed" : "open", name: str(o.name, o.category === "closed" ? "Closed" : "Open"), closeReason: optStr(o.closeReason) };
}

function parseReactions(raw: unknown): IssueReaction[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((entry): IssueReaction[] => {
    const o = dict(entry);
    if (!o || typeof o.content !== "string") return [];
    return [{ content: o.content, count: num(o.count), viewerReacted: o.viewerReacted === true }];
  });
}

function parseCapabilities(raw: unknown): IssueCapabilities | null {
  const o = dict(raw);
  if (!o) return null;
  return {
    create: o.create === true, edit: o.edit === true, comment: o.comment === true, labels: o.labels === true,
    assignees: o.assignees === true, reactions: o.reactions === true, templates: o.templates === true,
    linkedPullRequests: o.linkedPullRequests === true, events: o.events === true, search: o.search === true,
  };
}

function parseEntry(raw: unknown): IssueListEntry | null {
  const o = dict(raw);
  if (!o || typeof o.key !== "string" || typeof o.title !== "string") return null;
  return {
    tracker: str(o.tracker, "github"), host: str(o.host, "github.com"), scope: str(o.scope), key: o.key,
    displayKey: str(o.displayKey, `#${o.key}`), title: o.title, url: str(o.url), author: parseActor(o.author),
    state: parseState(o.state), createdAt: str(o.createdAt), updatedAt: str(o.updatedAt), closedAt: optStr(o.closedAt),
    assignees: Array.isArray(o.assignees) ? o.assignees.map(parseActor).filter((a): a is IssueActor => a !== null) : [],
    labels: Array.isArray(o.labels) ? o.labels.map(parseLabel).filter((l): l is IssueLabel => l !== null) : [],
    commentCount: num(o.commentCount), projectId: str(o.projectId), projectTitle: str(o.projectTitle),
  };
}

export function parseIssueListResult(raw: unknown): IssueListResult {
  const o = dict(raw);
  if (!o) throw new Error("The server returned an invalid issue list.");
  const viewers: Record<string, string> = {};
  const rawViewers = dict(o.viewers);
  if (rawViewers) for (const [k, v] of Object.entries(rawViewers)) if (typeof v === "string") viewers[k] = v;
  const trackers: IssueTrackerSummary[] = (Array.isArray(o.trackers) ? o.trackers : []).flatMap((item) => {
    const t = dict(item);
    if (!t || typeof t.tracker !== "string") return [];
    return [{
      tracker: t.tracker, host: str(t.host), projectCount: Math.max(1, num(t.projectCount, 1)),
      capabilities: parseCapabilities(t.capabilities), configured: t.configured !== false, detail: optStr(t.detail),
    }];
  });
  const entries = (Array.isArray(o.entries) ? o.entries : []).map(parseEntry).filter((e): e is IssueListEntry => e !== null);
  const errors: IssueListProjectError[] = (Array.isArray(o.errors) ? o.errors : []).flatMap((item) => {
    const e = dict(item);
    return e && typeof e.message === "string" ? [{ projectId: str(e.projectId), projectTitle: str(e.projectTitle), message: e.message }] : [];
  });
  const nextCursors: Record<string, string> = {};
  const rawCursors = dict(o.nextCursors);
  if (rawCursors) for (const [k, v] of Object.entries(rawCursors)) if (typeof v === "string") nextCursors[k] = v;
  const scopes = Array.isArray(o.scopes)
    ? o.scopes.flatMap((s): IssueScopeRef[] => {
        const x = dict(s);
        return x && typeof x.projectId === "string" && typeof x.tracker === "string" && typeof x.scope === "string"
          ? [{ projectId: x.projectId, tracker: x.tracker, scope: x.scope, ...(typeof x.host === "string" && x.host ? { host: x.host } : {}) }]
          : [];
      })
    : undefined;
  return { viewers, trackers, entries, errors, nextCursors, ...(scopes ? { scopes } : {}) };
}

function parseComment(raw: unknown): IssueComment | null {
  const o = dict(raw);
  if (!o || typeof o.id !== "string") return null;
  const reactions = parseReactions(o.reactions);
  return { id: o.id, author: parseActor(o.author), body: str(o.body), createdAt: str(o.createdAt), url: optStr(o.url), ...(reactions !== undefined ? { reactions } : {}) };
}

export function parseIssueCommentsPage(raw: unknown): { comments: IssueComment[]; nextCursor: string | null } {
  const o = dict(raw) ?? {};
  return {
    comments: (Array.isArray(o.comments) ? o.comments : []).map(parseComment).filter((c): c is IssueComment => c !== null),
    nextCursor: optStr(o.nextCursor),
  };
}

export function parseIssueDetail(raw: unknown): IssueDetail {
  const entry = parseEntry(raw);
  const o = dict(raw);
  if (!entry || !o) throw new Error("The server returned an invalid issue.");
  const caps = parseCapabilities(o.capabilities) ?? {
    create: false, edit: false, comment: false, labels: false, assignees: false,
    reactions: false, templates: false, linkedPullRequests: false, events: false, search: false,
  };
  const perms = dict(o.viewerPermissions) ?? {};
  const reactions = parseReactions(o.reactions);
  return {
    ...entry,
    writable: o.writable !== false,
    capabilities: caps,
    viewerPermissions: {
      setState: perms.setState !== false, comment: perms.comment !== false, edit: perms.edit !== false,
      labels: perms.labels !== false, assignees: perms.assignees !== false,
    },
    states: (Array.isArray(o.states) ? o.states : []).map(parseState),
    viewer: optStr(o.viewer),
    body: str(o.body),
    ...(reactions !== undefined ? { reactions } : {}),
    comments: (Array.isArray(o.comments) ? o.comments : []).map(parseComment).filter((c): c is IssueComment => c !== null),
    commentsCursor: optStr(o.commentsCursor),
    events: (Array.isArray(o.events) ? o.events : []).flatMap((item): IssueEvent[] => {
      const e = dict(item);
      if (!e || typeof e.id !== "string" || typeof e.kind !== "string") return [];
      return [{ id: e.id, kind: e.kind as IssueEventKind, actor: parseActor(e.actor), createdAt: str(e.createdAt), detail: optStr(e.detail) }];
    }),
    linkedPullRequests: (Array.isArray(o.linkedPullRequests) ? o.linkedPullRequests : []).flatMap((item): IssueLinkedPullRequest[] => {
      const p = dict(item);
      if (!p || typeof p.repository !== "string" || typeof p.number !== "number") return [];
      return [{ repository: p.repository, number: p.number, title: str(p.title), url: str(p.url), state: str(p.state, "open"), isDraft: p.isDraft === true, closesIssue: p.closesIssue === true }];
    }),
  };
}

export function parseIssueCandidates(raw: unknown): IssueCandidates {
  const o = dict(raw) ?? {};
  return {
    labels: (Array.isArray(o.labels) ? o.labels : []).flatMap((item): IssueLabelCandidate[] => {
      const l = parseLabel(item);
      return l ? [{ ...l, description: l.description ?? null }] : [];
    }),
    assignees: (Array.isArray(o.assignees) ? o.assignees : []).flatMap((item): IssueAssigneeCandidate[] => {
      const a = parseActor(item);
      const x = dict(item);
      return a && typeof x?.id === "string" ? [{ ...a, id: x.id }] : [];
    }),
    truncated: o.truncated === true,
  };
}

export function parseIssueLinkedThreads(raw: unknown): IssueLinkedThread[] {
  const list = dict(raw)?.threads;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): IssueLinkedThread[] => {
    const t = dict(item);
    if (!t || typeof t.id !== "string" || !t.id) return [];
    return [{ id: t.id, projectId: str(t.projectId), title: str(t.title), archivedAt: optStr(t.archivedAt), settled: t.settled === true }];
  });
}

export function parseIssueTrackerConnections(raw: unknown): IssueTrackerConnectionList {
  const o = dict(raw) ?? {};
  const trackers: IssueTrackerConnection[] = (Array.isArray(o.trackers) ? o.trackers : []).flatMap((item): IssueTrackerConnection[] => {
    const t = dict(item);
    if (!t || typeof t.tracker !== "string") return [];
    const cred = dict(t.credential) ?? {};
    return [{
      tracker: t.tracker,
      displayName: str(t.displayName, t.tracker),
      scopeNoun: str(t.scopeNoun, "team"),
      credential: { label: str(cred.label, "API key"), helpUrl: optStr(cred.helpUrl) },
      connected: t.connected === true,
      account: optStr(t.account),
      workspace: optStr(t.workspace),
      detail: optStr(t.detail),
      scopes: (Array.isArray(t.scopes) ? t.scopes : []).flatMap((s) => {
        const sc = dict(s);
        return sc && typeof sc.key === "string" ? [{ key: sc.key, name: str(sc.name, sc.key) }] : [];
      }),
    }];
  });
  const bindings: Record<string, { tracker: string; scope: string }> = {};
  const rawBindings = dict(o.bindings);
  if (rawBindings) {
    for (const [k, v] of Object.entries(rawBindings)) {
      const b = dict(v);
      if (b && typeof b.tracker === "string" && typeof b.scope === "string") bindings[k] = { tracker: b.tracker, scope: b.scope };
    }
  }
  return { trackers, bindings };
}

export function issueTrackerSummary(tracker: IssueTrackerConnection, bindings: Record<string, { tracker: string; scope: string }>): string {
  if (!tracker.connected) return `Not connected. Add a ${tracker.credential.label.toLowerCase()} to list its issues.`;
  if (tracker.account === null) return tracker.detail ?? "The saved credential was rejected.";
  const linked = Object.values(bindings).filter((b) => b.tracker === tracker.tracker).length;
  const projects = linked === 0
    ? `no projects linked yet. Pick a ${tracker.scopeNoun} for a project to list its issues.`
    : `${linked} ${linked === 1 ? "project" : "projects"} linked`;
  return `Connected as ${tracker.account} · ${projects}`;
}

export function issueTrackerDetailText(detail: string | null): string {
  return detail ?? "Unavailable";
}

export function issueTrackerKey(tracker: Pick<IssueTrackerSummary, "tracker" | "host">): string {
  return `${tracker.tracker} ${tracker.host.toLowerCase()}`;
}

export function issueTrackerPresentation(tracker: string): { providerName: string; icon: string } {
  switch (tracker) {
    case "github": return { providerName: "GitHub", icon: "git-pull-request" };
    case "gitlab": return { providerName: "GitLab", icon: "git-pull-request" };
    case "azure-devops": return { providerName: "Azure DevOps", icon: "git-pull-request" };
    case "forgejo": return { providerName: "Forgejo", icon: "git-pull-request" };
    case "linear": return { providerName: "Linear", icon: "layers" };
    default: return { providerName: tracker, icon: "circle-dot" };
  }
}

export function issueStatePresentation(state: IssueState): { label: string; icon: string; tone: { light: string; dark: string } } {
  if (state.category === "open") return { label: state.name, icon: "circle-dot", tone: { light: "#059669", dark: "#6ee7b7" } };
  if (state.closeReason && state.closeReason !== "completed") return { label: state.name, icon: "circle-slash", tone: { light: "#71717a", dark: "#a1a1aa" } };
  return { label: state.name, icon: "circle-check", tone: { light: "#7c3aed", dark: "#c4b5fd" } };
}

export function issueEventSentence(event: IssueEvent): string {
  switch (event.kind) {
    case "closed": return event.detail ? `closed this as ${event.detail.replace(/[-_]+/g, " ").trim().toLowerCase()}` : "closed this";
    case "reopened": return "reopened this";
    case "labeled": return event.detail ? `added the ${event.detail} label` : "added a label";
    case "unlabeled": return event.detail ? `removed the ${event.detail} label` : "removed a label";
    case "assigned": return event.detail ? `assigned ${event.detail}` : "assigned someone";
    case "unassigned": return event.detail ? `unassigned ${event.detail}` : "unassigned someone";
    case "renamed": return event.detail ? `renamed this to “${event.detail}”` : "renamed this";
    case "referenced": return event.detail ? `referenced this from ${event.detail}` : "referenced this";
    case "state-changed": return event.detail ? `moved this to ${event.detail}` : "changed the state";
  }
}

export function issueWriteAccess(detail: IssueDetail, canWrite: boolean) {
  const blocked = !canWrite
    ? "Writing to this tracker needs the source-control write scope."
    : !detail.writable
      ? "This issue is outside every project's own scope, so it is read-only here."
      : null;
  const may = (capability: boolean, permission: boolean) => blocked === null && capability && permission;
  return {
    blocked,
    comment: may(detail.capabilities.comment, detail.viewerPermissions.comment),
    edit: may(detail.capabilities.edit, detail.viewerPermissions.edit),
    labels: may(detail.capabilities.labels, detail.viewerPermissions.labels),
    assignees: may(detail.capabilities.assignees, detail.viewerPermissions.assignees),
    react: blocked === null && detail.capabilities.reactions,
    states: may(true, detail.viewerPermissions.setState) ? detail.states.filter((s) => s.name !== detail.state.name) : [],
  };
}

export function issueOrder(sort: IssueListSort) {
  const date = (issue: IssueListEntry) => Date.parse(sort === "created" ? issue.createdAt : issue.updatedAt);
  return (left: IssueListEntry, right: IssueListEntry) => date(right) - date(left);
}

export interface HeldIssuePage {
  readonly answer: IssueListResult;
  readonly entries: readonly IssueListEntry[];
  readonly errors: readonly IssueListProjectError[];
  readonly nextCursors: Record<string, string>;
  readonly moreFailure: string | null;
}

export function holdIssuePages(
  answers: ReadonlyArray<readonly [string, IssueListResult]>,
  pages: ReadonlyMap<string, HeldIssuePage>,
): ReadonlyMap<string, HeldIssuePage> {
  const next = new Map<string, HeldIssuePage>();
  for (const [envId, answer] of answers) {
    const previous = pages.get(envId);
    next.set(
      envId,
      previous?.answer === answer
        ? previous
        : { answer, entries: answer.entries, errors: answer.errors, nextCursors: answer.nextCursors, moreFailure: null },
    );
  }
  return next;
}

export function issueCursorsForHost(cursors: Record<string, string>, host: string): Record<string, string> {
  return Object.fromEntries(Object.entries(cursors).filter(([k]) => k.startsWith(`${host} `)));
}

export function mergeIssueEntries(existing: readonly IssueListEntry[], incoming: readonly IssueListEntry[]): IssueListEntry[] {
  const seen = new Set(existing.map((e) => e.url));
  const out = [...existing];
  for (const item of incoming) if (!seen.has(item.url)) { seen.add(item.url); out.push(item); }
  return out;
}

export function continueIssuePage(page: HeldIssuePage, next: IssueListResult | { failure: string }, asked: Record<string, string>): HeldIssuePage {
  if ("failure" in next) return { ...page, moreFailure: next.failure };
  const remainingCursors = Object.fromEntries(Object.entries(page.nextCursors).filter(([k]) => !(k in asked)));
  return {
    answer: page.answer,
    entries: mergeIssueEntries(page.entries, next.entries),
    errors: [...page.answer.errors, ...next.errors],
    nextCursors: { ...remainingCursors, ...next.nextCursors },
    moreFailure: null,
  };
}

export function groupIssues(
  held: ReadonlyMap<string, HeldIssuePage>,
  query: string,
  projects: readonly { id: string; environmentId?: string; provider?: string | null }[],
  sort: IssueListSort = "updated",
) {
  const byTracker = new Map<string, { tracker: IssueTrackerSummary; rows: EnvironmentIssueEntry[]; errors: Array<{ projectTitle: string; message: string; environmentId: string }>; more: string[] }>();
  const listed = new Set<string>();
  const needle = query.trim().toLowerCase();
  for (const [envId, page] of held) {
    for (const tracker of page.answer.trackers) {
      const key = issueTrackerKey(tracker);
      if (!byTracker.has(key)) byTracker.set(key, { tracker, rows: [], errors: [], more: [] });
      const group = byTracker.get(key)!;
      if (!group.tracker.configured && tracker.configured) group.tracker = tracker;
      if (Object.keys(page.nextCursors).some((c) => c.startsWith(`${tracker.host} `)) && !group.more.includes(envId)) {
        group.more.push(envId);
      }
    }
    for (const entry of page.entries) {
      const key = issueTrackerKey(entry);
      const group = byTracker.get(key);
      if (!group) continue;
      if (needle.length > 0 && group.tracker.capabilities?.search !== true
        && !entry.title.toLowerCase().includes(needle) && !entry.displayKey.toLowerCase().includes(needle)) continue;
      if (listed.has(entry.url)) continue;
      listed.add(entry.url);
      group.rows.push({ ...entry, environmentId: envId });
    }
    for (const error of page.errors) {
      const group = [...byTracker.values()][0];
      void projects;
      group?.errors.push({ projectTitle: error.projectTitle, message: error.message, environmentId: envId });
    }
  }
  for (const group of byTracker.values()) group.rows.sort(issueOrder(sort));
  return [...byTracker.values()].sort((a, b) => issueTrackerKey(a.tracker).localeCompare(issueTrackerKey(b.tracker)));
}

/** Parse Linear issue URL: https://linear.app/<workspace>/issue/<TEAM>-<NUMBER>[/slug]. */
export function parseLinearIssueUrl(url: string): { host: string; workspace: string; scope: string; key: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== LINEAR_HOST) return null;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 3 || segments[1]?.toLowerCase() !== "issue") return null;
    const workspace = segments[0]!;
    const key = segments[2]!;
    const dash = key.indexOf("-");
    if (dash <= 0 || !/^\d+$/u.test(key.slice(dash + 1))) return null;
    const scope = key.slice(0, dash);
    return { host: LINEAR_HOST, workspace, scope, key: key.toUpperCase() };
  } catch {
    return null;
  }
}

export function mayContainStandaloneIssueLink(text: string): boolean {
  return text.includes(`${LINEAR_HOST}/`);
}

/** Parse GitHub/GitLab/AzureDevOps/Linear issue link and match it to a project or bound tracker (#38854). */
export function resolveIssueLinkTarget(input: {
  url: string;
  projects: readonly { id: string; repositoryIdentity?: { provider?: string; host?: string; owner?: string; name?: string } | null }[];
  preferredProjectId?: string;
  trackers?: IssueTrackerConnectionList;
}): { projectId: string; ref: IssueRef } | null {
  const linear = parseLinearIssueUrl(input.url);
  if (linear && input.trackers) {
    const conn = input.trackers.trackers.find((t) => t.tracker === LINEAR_KIND && t.account !== null);
    if (conn && (!conn.workspace || conn.workspace.toLowerCase() === linear.workspace.toLowerCase())) {
      const bound = Object.entries(input.trackers.bindings)
        .filter(([, b]) => b.tracker === LINEAR_KIND)
        .map(([projectId, b]) => ({ projectId, binding: b }));
      const own = bound.find((c) => c.projectId === input.preferredProjectId && c.binding.scope.toLowerCase() === linear.scope.toLowerCase())
        ?? bound.find((c) => c.binding.scope.toLowerCase() === linear.scope.toLowerCase());
      const lender = own ?? bound.find((c) => c.projectId === input.preferredProjectId) ?? bound[0];
      if (lender) {
        return {
          projectId: lender.projectId,
          ref: { projectId: lender.projectId, tracker: LINEAR_KIND, host: linear.host, scope: own ? lender.binding.scope : linear.scope, key: linear.key },
        };
      }
    }
    return null;
  }
  try {
    const parsed = new URL(input.url);
    const host = parsed.hostname.toLowerCase();
    const parts = parsed.pathname.split("/").filter(Boolean);
    // GitHub: /:owner/:repo/issues/:number
    if (parts.length >= 4 && parts[2] === "issues" && /^\d+$/u.test(parts[3]!)) {
      const scope = `${parts[0]}/${parts[1]}`;
      const match = input.projects.find((p) => p.id === input.preferredProjectId)
        ?? input.projects[0];
      if (match) return { projectId: match.id, ref: { projectId: match.id, tracker: "github", host, scope, key: parts[3]! } };
    }
    // GitLab: /:group/.../:project/-/issues/:number
    const dashIdx = parts.indexOf("-");
    if (dashIdx >= 2 && parts[dashIdx + 1] === "issues" && /^\d+$/u.test(parts[dashIdx + 2] ?? "")) {
      const scope = parts.slice(0, dashIdx).join("/");
      const match = input.projects.find((p) => p.id === input.preferredProjectId) ?? input.projects[0];
      if (match) return { projectId: match.id, ref: { projectId: match.id, tracker: "gitlab", host, scope, key: parts[dashIdx + 2]! } };
    }
  } catch { /* ignore invalid URL */ }
  return null;
}

export { pullRequestLabelColor };
