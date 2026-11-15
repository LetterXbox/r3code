// The media block above a user bubble, from TimelineUserMessageRow.tsx: one image keeps its own
// shape (h-48, rounded-2xl); several share one rounded w-80 collage split by hairlines.
import type { MessageAttachment } from "./AttachmentPreview";

const THUMBNAIL_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const THUMBNAIL_BYTES = 10 * 1024 * 1024;
const LONE_HEIGHT = 192;
const LONE_MIN_WIDTH = 96;
/** T3's h-48 w-64 placeholder while a lone image is loading. */
export const LONE_IMAGE_FALLBACK_WIDTH = 256;
export const COLLAGE_WIDTH = 320;

export function isThumbnailImage(attachment: MessageAttachment): boolean {
  return attachment.type === "image" && THUMBNAIL_TYPES.includes(attachment.mimeType.toLowerCase().split(";")[0].trim());
}

const mimeOf = (attachment: MessageAttachment) => attachment.mimeType.toLowerCase().split(";")[0].trim();

/** isVideoAttachment: a file whose type is video/*. */
export function isVideoAttachment(attachment: MessageAttachment): boolean {
  return attachment.type !== "image" && mimeOf(attachment).startsWith("video/");
}

/** filePreviewKind "audio": a file whose type is audio/*. */
export function isAudioAttachment(attachment: MessageAttachment): boolean {
  return attachment.type !== "image" && mimeOf(attachment).startsWith("audio/");
}

/** Images, videos and audio get their own blocks; everything else is a file card. */
export function splitAttachments(attachments: readonly MessageAttachment[]) {
  return {
    images: attachments.filter(isThumbnailImage),
    videos: attachments.filter(isVideoAttachment),
    audio: attachments.filter(isAudioAttachment),
    files: attachments.filter((attachment) => !isThumbnailImage(attachment) && !isVideoAttachment(attachment) && !isAudioAttachment(attachment)),
  };
}

/** The largest video or audio file played inline; bigger ones keep their file card. */
export const PLAYER_BYTES = 64 * 1024 * 1024;

/** "1:05": minutes and zero-padded seconds. */
export function formatClock(seconds: number): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** A lone image is h-48 and as wide as its aspect, bounded by the available message width in the view. */
export function loneImageWidth(size: { width: number; height: number } | null): number {
  if (!size || size.width <= 0 || size.height <= 0) return LONE_IMAGE_FALLBACK_WIDTH;
  return Math.round(Math.max(LONE_MIN_WIDTH, (LONE_HEIGHT * size.width) / size.height));
}
export const LONE_IMAGE_HEIGHT = LONE_HEIGHT;

/** Two images: side by side at 12rem. Three: a 3fr tall cell beside two stacked 2fr cells. Four or more: rows of two at 6rem, an odd last image spanning the row. */
export function collageRows(count: number): { kind: "pair" | "trio" | "grid"; rows: number[][]; height: number } {
  if (count === 2) return { kind: "pair", rows: [[0, 1]], height: 192 };
  if (count === 3) return { kind: "trio", rows: [[0], [1, 2]], height: 192 };
  const rows: number[][] = [];
  for (let index = 0; index < count; index += 2) rows.push(index + 1 < count ? [index, index + 1] : [index]);
  return { kind: "grid", rows, height: rows.length * 96 };
}

const UNITS = ["B", "KB", "MB", "GB"];

/** formatBytes: "1.2 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit += 1; }
  const text = unit === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${UNITS[unit]}`;
}

/** "PDF · 123 B": the extension in capitals, else "File". */
export function fileCardDetail(attachment: MessageAttachment, sending = false): string {
  // UserFileCard: "Sending…" until the server holds the file; a pasted text drops the extension.
  if (sending) return "Sending\u2026";
  if (attachment.source === "pasted-text") return formatBytes(attachment.sizeBytes);
  const extension = /\.([a-z0-9]{1,8})$/i.exec(attachment.name)?.[1]?.toUpperCase() ?? "File";
  return `${extension} · ${formatBytes(attachment.sizeBytes)}`;
}

/** userMessageFileLabel: a long paste folded into a file reads "Pasted text". */
export function userMessageFileLabel(attachment: Pick<MessageAttachment, "name" | "source">): string {
  return attachment.source === "pasted-text" ? "Pasted text" : attachment.name;
}
