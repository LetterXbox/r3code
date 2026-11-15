import { readFile, stat } from "fs/promises";
import { basename, isAbsolute } from "path";
import { platform } from "nsh";

export type AttachmentKind = "image" | "file";
export type AttachmentStatus = "ready" | "uploading" | "uploaded" | "failed";
export interface DraftAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  kind: AttachmentKind;
  status: AttachmentStatus;
  error?: string;
  /** attachmentUploadQueue: upload progress 0..1 while `status` is "uploading". */
  progress?: number;
}
export interface AttachmentCapabilities {
  supported: boolean;
  files: boolean;
  maxCount: number;
  maxImageBytes: number;
  maxFileBytes: number;
  maxTotalImageBytes: number;
}
export const IMAGE_TYPES = ["image/gif", "image/jpeg", "image/png", "image/webp"];
export const MAX_ATTACHMENT_COUNT = 100;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 80 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", txt: "text/plain", md: "text/markdown", json: "application/json", pdf: "application/pdf",
  csv: "text/csv", html: "text/html", css: "text/css", js: "text/javascript", ts: "text/typescript",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo", ogv: "video/ogg", mp3: "audio/mpeg", wav: "audio/wav", zip: "application/zip",
};

const GENERIC_MIME_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);
const VIDEO_EXTENSIONS = ["avi", "m4v", "mkv", "mov", "mp4", "ogv", "webm"];

/** shared/video.ts videoMimeType: a `video/*` type, or (for an unset or generic type) the one the extension names. */
export function videoMimeType(attachment: { name: string; mimeType: string }): string | null {
  const mimeType = attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mimeType.startsWith("video/") && !GENERIC_MIME_TYPES.has(mimeType)) return mimeType;
  if (mimeType !== "" && !GENERIC_MIME_TYPES.has(mimeType)) return null;
  const dot = attachment.name.lastIndexOf(".");
  const extension = dot < 0 ? "" : attachment.name.slice(dot + 1).toLowerCase();
  return VIDEO_EXTENSIONS.includes(extension) ? (MIME_TYPES[extension] ?? null) : null;
}

/** types.ts isVideoAttachment. */
export const isVideoAttachment = (attachment: { name: string; mimeType: string }): boolean => videoMimeType(attachment) !== null;

export function attachmentMimeType(name: string, mime: string): string {
  const normalized = mime.trim().toLowerCase();
  if (normalized) return normalized;
  const extension = name.toLowerCase().split(".").pop() ?? "";
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

/** Read only the path the user selected, after checking its size. */
export function attachmentLocalPath(input: string, os: string | undefined = platform?.os): string {
  let path = input;
  if (input.startsWith("file:")) {
    const url = new URL(input);
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) throw new Error("Choose a local file");
    path = decodeURIComponent(url.pathname);
  }
  // These macOS system aliases are absolute symlinks. The host's confined
  // filesystem refuses to follow them even when the target is permitted.
  if (os === "macos" && (path === "/var" || path.startsWith("/var/") || path === "/tmp" || path.startsWith("/tmp/"))) return `/private${path}`;
  return os === "windows" && /^\/[a-z]:\//i.test(path) ? path.slice(1).replaceAll("/", "\\") : path;
}

export async function attachmentFileFromPath(input: string): Promise<File> {
  const path = attachmentLocalPath(input);
  if (!isAbsolute(path)) throw new Error("Enter an absolute local file path");
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Choose a regular file");
  if (!info.size || info.size > MAX_FILE_BYTES) throw new Error("Files must be between 1 byte and 50 MiB");
  const bytes = await readFile(path);
  if (bytes.length !== info.size) throw new Error("The file changed while it was being read; choose it again");
  const name = basename(path) || "attachment";
  return new File([bytes], name, { type: attachmentMimeType(name, "") });
}

/** Only server-issued relative upload URLs on the current environment are allowed. */
export function attachmentUploadUrl(endpoint: string, relativeUrl: string): string {
  if (!relativeUrl.startsWith("/api/attachments/upload/") || relativeUrl.startsWith("//")) throw new Error("Environment returned an invalid upload URL");
  const base = new URL(endpoint);
  base.protocol = base.protocol === "wss:" ? "https:" : "http:";
  base.pathname = "/";
  base.search = "";
  base.hash = "";
  const target = new URL(relativeUrl, base);
  if (target.origin !== base.origin || !target.pathname.startsWith("/api/attachments/upload/")) throw new Error("Environment returned an invalid upload URL");
  return target.toString();
}

/** attachmentUploadState.formatAttachmentUploadProgress: "NN%" from a 0..1 progress, clamped. */
export function formatAttachmentUploadProgress(progress: number): string {
  const bounded = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  return `${Math.floor(bounded * 100)}%`;
}

/**
 * attachmentUploadQueue.uploadBytes progress without XMLHttpRequest: the file is sent as a streamed
 * body (fetch sends a ReadableStream chunked as it is read) and progress counts the bytes handed to
 * the transport, reported in 5% steps like the reference (Math.floor(progress * 20)).
 */
export function progressUploadBody(file: Blob, onProgress: (progress: number) => void, chunkBytes = 64 * 1024): ReadableStream<Uint8Array> {
  const total = file.size;
  let sent = 0;
  let lastStep = -1;
  return new ReadableStream<Uint8Array>({
    // Pulled as the transport takes bytes; the file is cut into slices so progress has steps.
    async pull(controller) {
      if (sent >= total) { controller.close(); return; }
      const end = Math.min(total, sent + chunkBytes);
      const chunk = new Uint8Array(await file.slice(sent, end).arrayBuffer());
      sent = end;
      controller.enqueue(chunk);
      const progress = total > 0 ? sent / total : 1;
      const step = Math.floor(progress * 20);
      if (step !== lastStep) { lastStep = step; onProgress(progress); }
      if (sent >= total) controller.close();
    },
  });
}
