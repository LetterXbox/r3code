// What the thread header reads off a shell thread beyond its title: the parent
// thread (ChatView.tsx's parentThreadLink), the link origin badge and the guest
// share (GuestShareControls.tsx). Pure, so it is tested without an engine.

import type { ThreadIssueLink } from "../issue/issueLogic";

export type { ThreadIssueLink };

export interface ThreadRelations {
  /** Set for a side chat or a subagent: the thread it lives under. */
  parentThreadId: string | null;
  /** "From <label>": the linked environment whose agent started the thread. */
  linkOrigin: string | null;
  guestShare: GuestShare | null;
  /** The lineage as the server sent it, for the details card's Lineage and Side chats sections. */
  lineage?: ThreadLineage;
  /** Run-based forks use their source thread in the relationship graph. */
  forkSourceThreadId?: string;
  /** Set on a provider-native subagent (isProviderNativeSubagentThread): it takes no messages, so the chat shows a bar. */
  providerSubagent?: { instanceId: string; model: string; effort: string | null };
  /** The pull requests linked to the thread (`ThreadPullRequestLink`), newest first. */
  pullRequests?: LinkedPullRequest[];
  /** The issues linked to the thread (`ThreadIssueLink`), newest first. */
  issues?: ThreadIssueLink[];
  /** The thread on a linked environment whose agent delegated this one (`delegatedFrom`). */
  delegatedFrom?: { environmentId: string; threadId: string; title: string };
}

export interface ThreadLineage {
  parentThreadId: string | null;
  relationshipToParent: "fork" | "subagent" | null;
  rootThreadId: string | null;
  sideChat: boolean;
}

export interface LinkedPullRequest {
  host: string;
  repository: string;
  number: number;
  url: string;
  source: string;
  linkedAt: string;
  /** The link's snapshot, once the server has synced one. */
  snapshot: { state: string; title: string; isDraft: boolean; headBranch: string; baseBranch: string; additions: number; deletions: number; changedFiles: number; checksState: string | null; reviewDecision: string | null } | null;
  watching: boolean;
}

export interface GuestMessage { id: string; text: string; status: "pending" | "sent" | "dismissed"; submittedAt: string; attachments: { id: string; name: string; mimeType: string; type: string; sizeBytes?: number }[] }
export interface GuestShare { id: string; guestName: string | null; expiresAt: string; /** The waiting, sent and dismissed messages (`ThreadGuestShare.messages`). */ messages?: GuestMessage[] }

/** `ThreadGuestShare.messages`, read defensively. */
export function readGuestMessages(value: unknown): GuestMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): GuestMessage[] => {
    const message = record(entry);
    if (!message || typeof message.id !== "string" || typeof message.text !== "string") return [];
    const status = message.status === "pending" || message.status === "sent" || message.status === "dismissed" ? message.status : null;
    if (status === null) return [];
    const attachments = Array.isArray(message.attachments) ? message.attachments.flatMap((item) => {
      const file = record(item);
      return file && typeof file.id === "string" ? [{ id: file.id, name: typeof file.name === "string" ? file.name : "", mimeType: typeof file.mimeType === "string" ? file.mimeType : "", type: typeof file.type === "string" ? file.type : "file", ...(typeof file.sizeBytes === "number" && Number.isFinite(file.sizeBytes) ? { sizeBytes: file.sizeBytes } : {}) }] : [];
    }) : [];
    return [{ id: message.id, text: message.text, status, submittedAt: typeof message.submittedAt === "string" ? message.submittedAt : "", attachments }];
  });
}

/** pendingGuestMessageCount's messages: the ones waiting for the owner to send or dismiss. */
export const pendingGuestMessages = (share: GuestShare | null | undefined): GuestMessage[] => share?.messages?.filter((message) => message.status === "pending") ?? [];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readLineage(value: Record<string, unknown> | null): ThreadLineage | undefined {
  if (!value) return undefined;
  const relationship = value.relationshipToParent === "fork" || value.relationshipToParent === "subagent" ? value.relationshipToParent : null;
  const parent = typeof value.parentThreadId === "string" && value.parentThreadId ? value.parentThreadId : null;
  const sideChat = value.sideChat === true;
  if (parent === null && relationship === null && !sideChat) return undefined;
  return { parentThreadId: parent, relationshipToParent: relationship, rootThreadId: typeof value.rootThreadId === "string" ? value.rootThreadId : null, sideChat };
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function readLinkedIssues(value: unknown): ThreadIssueLink[] {
  if (!Array.isArray(value)) return [];
  const links: ThreadIssueLink[] = [];
  for (const item of value) {
    const link = record(item);
    if (!link || typeof link.tracker !== "string" || typeof link.key !== "string" || typeof link.url !== "string") continue;
    links.push({
      tracker: link.tracker,
      host: text(link.host),
      scope: text(link.scope),
      key: link.key,
      projectId: text(link.projectId),
      url: link.url,
      source: text(link.source),
      linkedAt: text(link.linkedAt),
      displayKey: text(link.displayKey) || link.key,
      title: text(link.title),
    });
  }
  return links.sort((a, b) => (Date.parse(b.linkedAt) || 0) - (Date.parse(a.linkedAt) || 0));
}

/** The live links (a dismissed stack member is hidden), newest first. */
export function readLinkedPullRequests(value: unknown): LinkedPullRequest[] {
  if (!Array.isArray(value)) return [];
  const links: LinkedPullRequest[] = [];
  for (const item of value) {
    const link = record(item);
    if (!link || link.source === "stack-dismissed" || typeof link.number !== "number" || typeof link.url !== "string" || typeof link.repository !== "string") continue;
    const snapshot = record(link.snapshot);
    links.push({
      host: text(link.host), repository: link.repository, number: link.number, url: link.url, source: text(link.source), linkedAt: text(link.linkedAt),
      snapshot: snapshot ? {
        state: text(snapshot.state), title: text(snapshot.title), isDraft: snapshot.isDraft === true, headBranch: text(snapshot.headBranch), baseBranch: text(snapshot.baseBranch),
        additions: count(snapshot.additions), deletions: count(snapshot.deletions), changedFiles: count(snapshot.changedFiles),
        checksState: typeof snapshot.checksState === "string" ? snapshot.checksState : null, reviewDecision: typeof snapshot.reviewDecision === "string" ? snapshot.reviewDecision : null,
      } : null,
      watching: record(link.watch) !== null,
    });
  }
  return links.sort((a, b) => (Date.parse(b.linkedAt) || 0) - (Date.parse(a.linkedAt) || 0));
}

/** The reasoning effort a model selection carries in its options (`{ id: "reasoningEffort" | "effort", value }`). */
function selectionEffort(selection: Record<string, unknown>): string | null {
  if (!Array.isArray(selection.options)) return null;
  for (const option of selection.options) {
    const item = record(option);
    if (item && (item.id === "reasoningEffort" || item.id === "effort") && typeof item.value === "string" && item.value) return item.value;
  }
  return null;
}

/** Reads one raw shell record. Forks have a parent too, but the web only links side chats and subagents. */
export function threadRelationsFromShell(value: Record<string, unknown>): ThreadRelations | undefined {
  const lineage = record(value.lineage);
  const parent = typeof lineage?.parentThreadId === "string" && lineage.parentThreadId ? lineage.parentThreadId : null;
  const linksParent = lineage?.sideChat === true || lineage?.relationshipToParent === "subagent";
  const origin = record(value.linkOrigin);
  const share = record(value.guestShare);
  const guestShare: GuestShare | null = share && typeof share.id === "string" && typeof share.expiresAt === "string"
    ? { id: share.id, guestName: typeof share.guestName === "string" ? share.guestName : null, expiresAt: share.expiresAt, messages: readGuestMessages(share.messages) }
    : null;
  const fullLineage = readLineage(lineage);
  const forkedFrom = record(value.forkedFrom);
  const forkSourceThreadId = forkedFrom?.type === "run" && typeof forkedFrom.threadId === "string" && forkedFrom.threadId ? forkedFrom.threadId : undefined;
  const pullRequests = readLinkedPullRequests(value.pullRequests);
  const issues = readLinkedIssues(value.issues);
  const selection = record(value.modelSelection);
  const providerSubagent = fullLineage?.relationshipToParent === "subagent" && value.creationSource === "provider" && typeof selection?.model === "string"
    ? { instanceId: typeof selection.instanceId === "string" ? selection.instanceId : "", model: selection.model, effort: selectionEffort(selection) }
    : null;
  const delegated = record(value.delegatedFrom);
  const delegatedFrom = delegated && typeof delegated.environmentId === "string" && typeof delegated.threadId === "string"
    ? { environmentId: delegated.environmentId, threadId: delegated.threadId, title: typeof delegated.title === "string" ? delegated.title : "" }
    : null;
  const relations: ThreadRelations = {
    parentThreadId: linksParent ? parent : null,
    linkOrigin: typeof origin?.label === "string" && origin.label ? origin.label : null,
    guestShare,
    ...(fullLineage ? { lineage: fullLineage } : {}),
    ...(forkSourceThreadId ? { forkSourceThreadId } : {}),
    ...(providerSubagent ? { providerSubagent } : {}),
    ...(pullRequests.length > 0 ? { pullRequests } : {}),
    ...(issues.length > 0 ? { issues } : {}),
    ...(delegatedFrom ? { delegatedFrom } : {}),
  };
  return relations.parentThreadId || relations.linkOrigin || relations.guestShare || relations.lineage || relations.forkSourceThreadId || relations.providerSubagent || relations.pullRequests || relations.delegatedFrom ? relations : undefined;
}

/** GuestShareStatus: the share stays on the thread after it expires, until the owner clears it. */
export function guestShareLabel(share: GuestShare, nowIso: string): string {
  if (share.expiresAt.slice(0, 16) <= nowIso.slice(0, 16)) return "Guest link expired";
  return share.guestName !== null ? `${share.guestName} is a guest` : "Guest link active";
}

/** The title the parent breadcrumb shows until the client knows the parent thread. */
export function parentBreadcrumbTitle(parentTitle: string | undefined): string {
  return parentTitle && parentTitle.length > 0 ? parentTitle : "Parent thread";
}
