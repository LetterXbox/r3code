// pendingUserInput.ts:14-35: thread chips typed into an answer become thread links (formatThreadLink), so the provider
// gets a link it can follow rather than the composer's private context marker.
const THREAD_MARKER = /\[([^\]]*)\]\(t3-context:\/\/v1\/thread\/([A-Za-z0-9_-]{1,128})\)/g;

export interface ThreadAnswerRecord { contextId: string; environmentId: string; threadId: string }

const linkLabel = (label: string) => label.replace(/[[\]\\\r\n]/g, " ").replace(/\s+/g, " ").trim();

/** formatThreadLink (shared/threadLinks.ts:127): `t3-thread://v2/<environment>/<thread>`, v1 without an environment. */
export function formatThreadLink(ref: { environmentId: string | null; threadId: string }, label?: string): string {
  const href = ref.environmentId ? `t3-thread://v2/${ref.environmentId}/${ref.threadId}` : `t3-thread://v1/${ref.threadId}`;
  const destination = /[()]/.test(href) ? `<${href}>` : href;
  const cleaned = label === undefined ? "" : linkLabel(label);
  return cleaned ? `[${cleaned}](${destination})` : `<${href}>`;
}

export function projectPendingUserInputAnswer(answer: unknown, records: readonly ThreadAnswerRecord[]): unknown {
  if (typeof answer !== "string" || records.length === 0) return answer;
  const byId = new Map(records.map((record) => [record.contextId, record]));
  return answer.replace(THREAD_MARKER, (source, label: string, contextId: string) => {
    const record = byId.get(contextId);
    return record ? formatThreadLink({ environmentId: record.environmentId || null, threadId: record.threadId }, label) : source;
  });
}

/** threadContextsReferencedByAnswer: only the records the answer still references. */
export function threadContextsReferencedByAnswer<T extends { contextId: string }>(answer: string, records: readonly T[]): T[] {
  const ids = new Set([...answer.matchAll(/\]\(t3-context:\/\/v1\/[a-z-]+\/([A-Za-z0-9_-]{1,128})\)/g)].map((match) => match[1]));
  return records.filter((record) => ids.has(record.contextId));
}
