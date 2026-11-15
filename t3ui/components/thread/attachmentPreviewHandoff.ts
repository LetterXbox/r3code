// useAttachmentPreviewHandoff.ts + session-logic.ts selectHandoffImageResources: a sent image keeps showing its local
// bytes until the server's copy is read, so the timeline does not flash an empty frame. The port uploads before the
// send, so the echo and the server message carry the same attachment id: the staged file's object URL is handed to
// the thumbnail cache under that id and the server read is skipped (the bytes are the same).
const handoff = new Map<string, string>();

/** Hands a sent image's staged bytes to the timeline under its server attachment id (images only). */
export function handOffAttachmentPreview(attachmentId: string, file: Blob, kind: string): void {
  if (kind !== "image" || handoff.has(attachmentId)) return;
  handoff.set(attachmentId, URL.createObjectURL(file));
}

/** The handed-off URL for an attachment, once: the caller owns it from then on. */
export function takeAttachmentPreviewHandoff(attachmentId: string): string | undefined {
  const url = handoff.get(attachmentId);
  if (url !== undefined) handoff.delete(attachmentId);
  return url;
}

