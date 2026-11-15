// useComposerAttachmentIntake + client-runtime textPaste.ts / state/attachments.ts: the copy and rules for taking files
// and large pastes into the draft.

export const PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES = 32 * 1024;
const encoder = new TextEncoder();

export type PastedTextDisposition = "attachment" | "inline";

/** Byte-based: character counts understate the context cost of Unicode-heavy clipboard contents. */
export function pastedTextDisposition(input: { text: string; canAttach: boolean; bypassAutoAttachment?: boolean; wouldExceedInputLimit?: boolean }): PastedTextDisposition {
  if (input.bypassAutoAttachment || !input.canAttach || input.text.length === 0) return "inline";
  return input.wouldExceedInputLimit || input.text.length >= PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES || encoder.encode(input.text).byteLength >= PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES
    ? "attachment" : "inline";
}

export function nextPastedTextFileName(existingNames: readonly string[]): string {
  const names = new Set(existingNames.map((name) => name.toLowerCase()));
  if (!names.has("pasted-text.txt")) return "pasted-text.txt";
  for (let sequence = 2; ; sequence += 1) {
    const candidate = `pasted-text-${sequence}.txt`;
    if (!names.has(candidate)) return candidate;
  }
}

export function formatAttachmentSize(sizeBytes: number): string {
  const kilobytes = Math.max(1, Math.ceil(sizeBytes / 1024));
  return kilobytes >= 1024 ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB` : `${kilobytes} KB`;
}

export function fileAttachmentTooLargeMessage(name: string, maxUploadBytes: number): string {
  const maxUploadSize = maxUploadBytes >= 1024 * 1024 && maxUploadBytes % (1024 * 1024) === 0
    ? `${maxUploadBytes / (1024 * 1024)} MB`
    : maxUploadBytes >= 1024 && maxUploadBytes % 1024 === 0
      ? `${maxUploadBytes / 1024} KB`
      : `${maxUploadBytes} ${maxUploadBytes === 1 ? "byte" : "bytes"}`;
  return `'${name}' exceeds the ${maxUploadSize} attachment limit.`;
}

export const attachmentCountMessage = (max: number) => `You can attach up to ${max} files per message.`;

/**
 * A paste that changed the prompt from `before` to `after`: the inserted run and where it replaced text. The editor
 * inserts pasted text itself, so the composer recognises a large paste from the change it reports.
 */
export function insertedRun(before: string, after: string): { start: number; end: number; text: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let suffix = 0;
  while (suffix < before.length - start && suffix < after.length - start && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  return { start, end: before.length - suffix, text: after.slice(start, after.length - suffix) };
}

export type PasteFold =
  | { kind: "inline" }
  | { kind: "attach"; name: string; file: File }
  | { kind: "refuse"; title: string; description: string };

/** foldPastedText: a large paste becomes a `pasted-text` file; one that cannot be attached and would overflow the prompt is refused. */
export function foldPaste(input: { before: string; after: string; maxInputChars: number; canAttach: boolean; fileLimit: number | null; reservedNames: readonly string[] }): PasteFold {
  const run = insertedRun(input.before, input.after);
  if (run.text.length === 0) return { kind: "inline" };
  const wouldExceedInputLimit = input.before.length - (run.end - run.start) + run.text.length > input.maxInputChars;
  if (pastedTextDisposition({ text: run.text, canAttach: true, wouldExceedInputLimit }) !== "attachment") return { kind: "inline" };
  if (!input.canAttach || input.fileLimit === null) {
    if (!wouldExceedInputLimit) return { kind: "inline" };
    return { kind: "refuse", title: "Pasted text is too large for this message", description: "Remove some text or an attachment, then paste again." };
  }
  const name = nextPastedTextFileName(input.reservedNames);
  const file = new File([run.text], name, { type: "text/plain;charset=utf-8" });
  if (file.size > input.fileLimit) {
    if (!wouldExceedInputLimit) return { kind: "inline" };
    return { kind: "refuse", title: "Pasted text is too large to attach", description: "Reduce the clipboard contents or save a smaller excerpt as a file." };
  }
  return { kind: "attach", name, file };
}

/** The info toast after a fold: `Large paste attached as <name>`. */
export function pasteFoldedToast(name: string, sizeBytes: number, mac: boolean): { title: string; description: string } {
  return { title: `Large paste attached as ${name}`, description: `${formatAttachmentSize(sizeBytes)} · Use ${mac ? "⌘⇧V" : "Ctrl+Shift+V"} to keep a large paste inline.` };
}

// --- composerAttachmentFiles.ts: the staging limit and the send blocks that follow from the server's upload capability ---

const MAX_FILE_STAGING_BYTES = 50 * 1024 * 1024;

export interface FileAttachmentCapabilityState {
  /** The environment has reported its capabilities (attachmentUploadsCapabilityKnown). */
  known: boolean;
  /** Uploads of any kind are offered. */
  supported: boolean;
  /** The server's file upload limit in bytes; null or 0 when files are not accepted. */
  maxFileBytes: number | null;
}

/** fileAttachmentStagingLimit: bytes a file may be before it is refused (null: files are not accepted). */
export function fileAttachmentStagingLimit(input: FileAttachmentCapabilityState): number | null {
  if (!input.known) return MAX_FILE_STAGING_BYTES;
  if (!input.supported || input.maxFileBytes === null || input.maxFileBytes <= 0) return null;
  return Math.min(input.maxFileBytes, MAX_FILE_STAGING_BYTES);
}

/** fileAttachmentCapabilityBlockReason: why the files already in the draft cannot be sent (the send button's tooltip). */
export function fileAttachmentCapabilityBlockReason(input: FileAttachmentCapabilityState & { files: readonly { name: string; sizeBytes: number }[] }): string | null {
  if (input.files.length === 0) return null;
  if (!input.known) return "Waiting for the server before file attachments can send";
  const limit = fileAttachmentStagingLimit(input);
  if (limit === null) return "This server does not accept file attachments right now. Remove the files to send.";
  const oversized = input.files.find((file) => file.sizeBytes > limit);
  return oversized ? fileAttachmentTooLargeMessage(oversized.name, limit) : null;
}

/** ChatComposer attachmentBlockReason, in its order: question-answer support, file capability, then interrupted files. */
export function attachmentBlockReason(input: FileAttachmentCapabilityState & {
  files: readonly { name: string; sizeBytes: number }[];
  /** A question is being answered and the server cannot take attachments with an answer. */
  questionWithoutAttachmentSupport: boolean;
  hasAttachments: boolean;
  needsReattachCount: number;
}): string | null {
  if (input.questionWithoutAttachmentSupport && input.hasAttachments) return "Update this server to send files with question answers";
  const capability = fileAttachmentCapabilityBlockReason(input);
  if (capability) return capability;
  if (input.supported && input.needsReattachCount > 0) return input.needsReattachCount === 1 ? "Attach the interrupted file again or remove it" : "Attach the interrupted files again or remove them";
  return null;
}

/**
 * attachmentsToReleaseOnUploadCapabilityLoss: the draft attachments whose upload goes when the server stops offering uploads.
 * Only unpersisted ones: an uploaded file keeps its server copy (hydrated files still need it), a restored entry without its
 * bytes has nothing to upload again from, and one that never started uploading has nothing to release.
 */
export function attachmentsToReleaseOnUploadCapabilityLoss<T extends { kind: "image" | "file"; status: string; uploadedId?: string; file?: unknown }>(attachments: readonly T[]): T[] {
  return attachments.filter((item) => !(item.kind === "file" && item.uploadedId !== undefined) && item.file !== undefined && (item.status === "uploading" || item.status === "uploaded" || item.uploadedId !== undefined));
}

/** attachmentUploadQueue runUpload: the reasons shown on a failed upload (mint failure hides the server error; a non-2xx transfer names its status). */
export const ATTACHMENT_UPLOAD_COULD_NOT_START = "Upload could not start";
export const ATTACHMENT_UPLOAD_FAILED = "Upload failed";
export const attachmentUploadRejected = (status: number) => `Upload rejected (${status})`;
