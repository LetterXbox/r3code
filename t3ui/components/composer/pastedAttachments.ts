// useComposerContextImport (image / file records): an attachment chip pasted from another composer's prompt brings its attachment
// along. The web downloads the bytes from the source environment and adds them to this draft; here the bytes come from this
// process (the other draft still holds the file) or are read back from the server by their upload id, and `addAttachment` puts them
// in this draft (uploading them again, so deleting one draft's upload never takes the other's). The pasted chip is replaced by the
// one the new attachment gets.
import { addAttachment, draftHasAttachmentContext, findDraftAttachmentByContextId, setComposerDraft, composerDraftFor, withThreadScope } from "../../store";
import { readAttachment } from "../thread/readAttachment";

const ATTACHMENT_MARKER = /\[(?:\\.|[^\]\\]){0,200}\]\(t3-context:\/\/v1\/(image|file)\/([A-Za-z0-9_-]{1,128})\) ?/g;

/** The image and file context ids a pasted text names. */
export function pastedAttachmentContextIds(text: string): string[] {
  if (!text.includes("t3-context://v1/")) return [];
  return [...new Set([...text.matchAll(ATTACHMENT_MARKER)].map((match) => match[2] ?? ""))];
}

/** The prompt without the chip naming `contextId`. */
export function withoutAttachmentChip(text: string, contextId: string): string {
  return text.replace(ATTACHMENT_MARKER, (whole, _kind, id: string) => (id === contextId ? "" : whole));
}

/** pendingDraftWork: imports in flight per draft (counted, so overlapping pastes cannot release each other); a send waits for them. */
const pendingWork = new Map<string, number>();
export const pendingDraftWork = {
  begin(draftKey: string) { pendingWork.set(draftKey, (pendingWork.get(draftKey) ?? 0) + 1); },
  end(draftKey: string) { const left = (pendingWork.get(draftKey) ?? 0) - 1; if (left > 0) pendingWork.set(draftKey, left); else pendingWork.delete(draftKey); },
  has(draftKey: string) { return (pendingWork.get(draftKey) ?? 0) > 0; },
};

const imported = new Set<string>();

/** Imports each pasted attachment chip whose attachment lives in another thread's draft; resolves to how many were brought in. */
export async function importPastedAttachments(threadId: string, text: string, readSource?: (source: NonNullable<ReturnType<typeof findDraftAttachmentByContextId>>) => Promise<Blob | null>): Promise<number> {
  let count = 0;
  for (const contextId of pastedAttachmentContextIds(text)) {
    const key = `${threadId}:${contextId}`;
    if (imported.has(key) || draftHasAttachmentContext(threadId, contextId)) continue;
    const source = findDraftAttachmentByContextId(contextId, threadId);
    if (!source) continue;
    imported.add(key);
    pendingDraftWork.begin(threadId);
    try {
      const blob = readSource ? await readSource(source) : source.file ?? (source.uploadedId ? await readAttachment(source.uploadedId, { signal: new AbortController().signal, maxBytes: source.sizeBytes + 1 }) : null);
      if (!blob) continue;
      // The user may have deleted the pasted chip while its bytes were being read.
      if (!pastedAttachmentContextIds(composerDraftFor(threadId)).includes(contextId) || draftHasAttachmentContext(threadId, contextId)) continue;
      // Keep the original marker until intake succeeds, so validation failures do not erase draft text.
      await withThreadScope(threadId, () => addAttachment(new File([blob], source.name, { type: source.mimeType })));
      withThreadScope(threadId, () => setComposerDraft(withoutAttachmentChip(composerDraftFor(threadId), contextId)));
      count += 1;
    } catch { /* A later paste can retry the import. */ } finally { imported.delete(key); pendingDraftWork.end(threadId); }
  }
  return count;
}
