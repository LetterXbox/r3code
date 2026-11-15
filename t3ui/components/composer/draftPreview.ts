// ComposerAttachmentStrip "Preview <name>" (ExpandedImageDialog): a draft image opens in the thread's attachment
// preview, read from the staged bytes instead of the server.
import { signal } from "nsh";
import type { MessageAttachment } from "../thread/AttachmentPreview";

export interface DraftPreview { attachment: MessageAttachment; file: File }

export const draftPreview = signal<DraftPreview | null>(null);

export function openDraftPreview(item: { id: string; name: string; mimeType: string; sizeBytes: number }, file: File): void {
  draftPreview.set({ attachment: { type: "image", id: item.id, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes } as MessageAttachment, file });
}

export const readDraftPreview = async (): Promise<Blob> => {
  const current = draftPreview();
  if (!current) throw new Error("The attachment is no longer in this draft.");
  return current.file;
};
