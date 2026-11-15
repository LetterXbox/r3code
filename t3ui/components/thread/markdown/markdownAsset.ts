// Reads a workspace file the way the reference's `media-file` asset does: assets.createUrl mints a signed URL for the file
// (contracts AssetResource), the bytes come back through the same bounded reader the attachment preview uses. The bytes are
// then shown from an object URL, so the signed URL never reaches a view.
import { backendConnectionGeneration, backendUrl, requestBackend } from "../../../store";
import { readAttachmentWith } from "../readAttachment";

export const MEDIA_IMAGE_BYTES = 32 * 1024 * 1024;
export const MEDIA_PLAYER_BYTES = 64 * 1024 * 1024;

export function readMediaFile(threadId: string, path: string, options: { signal: AbortSignal; maxBytes: number }): Promise<Blob> {
  return readAttachmentWith({
    endpoint: backendUrl,
    generation: backendConnectionGeneration,
    mint: () => requestBackend("assets.createUrl", { resource: { _tag: "media-file", threadId, path } }),
    fetch,
  }, path, options);
}
