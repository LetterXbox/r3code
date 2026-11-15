// What a markdown image's source is and how it is shown: ported from packages/shared mediaPreview.ts and
// client-runtime markdownImages.ts, apps/web ChatMarkdownMedia.tsx (copy text, authored size, copy strings). Pure.
import {
  isNetworkPath,
  isWindowsAbsolutePath,
  normalizeMarkdownLinkDestination,
  parseFileUrlHref,
  safeDecodeURIComponent,
  splitMarkdownLinkSearchAndHash,
  stripSlashPrefixedWindowsDrive,
  workspaceRelativeFilePath,
} from "./fileLinkMeta";

import type { TextViewBlock, TextViewImage, TextViewInline } from "nsh/base";

export type MediaKind = "image" | "video" | "audio";

/** Where a piece of media is: a URL the views load directly, or a file on the environment host. */
export type MediaSource = { kind: "url"; url: string } | { kind: "file"; path: string; threadId: string };

export interface ExpandedMediaItem { name: string; kind: Exclude<MediaKind, "audio">; source: MediaSource }
export interface ExpandedMediaPreview { items: ExpandedMediaItem[]; index: number }

const IMAGE_MIME = new Map([
  [".avif", "image/avif"], [".bmp", "image/bmp"], [".heic", "image/heic"], [".heif", "image/heif"], [".gif", "image/gif"], [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"], [".jpg", "image/jpeg"], [".png", "image/png"], [".svg", "image/svg+xml"], [".tif", "image/tiff"], [".tiff", "image/tiff"], [".webp", "image/webp"],
]);
const VIDEO_MIME = new Map([
  [".mp4", "video/mp4"], [".m4v", "video/mp4"], [".mov", "video/quicktime"], [".webm", "video/webm"], [".ogv", "video/ogg"], [".mkv", "video/x-matroska"], [".avi", "video/x-msvideo"],
]);
const AUDIO_MIME = new Map([
  [".mp3", "audio/mpeg"], [".wav", "audio/wav"], [".ogg", "audio/ogg"], [".oga", "audio/ogg"], [".flac", "audio/flac"], [".aac", "audio/aac"], [".m4a", "audio/mp4"],
  [".opus", "audio/ogg"], [".aiff", "audio/aiff"], [".weba", "audio/webm"],
]);

/** Classifies a literal filesystem extension (with its dot): the image or video type, else null. */
export function mediaMimeTypeFromExtension(extension: string): string | null {
  if (!/^\.[a-z0-9]+$/i.test(extension)) return null;
  const key = extension.toLowerCase();
  return IMAGE_MIME.get(key) ?? VIDEO_MIME.get(key) ?? null;
}

/** Classifies an authored media path or URL: a data: type, else the extension's. */
export function mediaMimeType(path: string): string | null {
  const trimmed = path.trim();
  const source = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  const dataMimeType = /^data:((?:image|video|audio)\/[\w.+-]+)[;,]/i.exec(source)?.[1];
  if (dataMimeType) return dataMimeType.toLowerCase();
  let sourcePath = source.split(/[?#]/, 1)[0] ?? "";
  if (/^(?:https?:|file:|\/\/)/i.test(source)) {
    try { sourcePath = new URL(source, "https://media.invalid").pathname; } catch { return null; }
  }
  sourcePath = safeDecodeURIComponent(sourcePath);
  const basename = sourcePath.split(/[\\/]/).at(-1) ?? "";
  const extensionIndex = basename.lastIndexOf(".");
  if (extensionIndex < 0) return null;
  const extension = basename.slice(extensionIndex).toLowerCase();
  return mediaMimeTypeFromExtension(extension) ?? AUDIO_MIME.get(extension) ?? null;
}

export function mediaKindFromPath(path: string): MediaKind | null {
  const mimeType = mediaMimeType(path);
  if (mimeType === null) return null;
  return mimeType.startsWith("audio/") ? "audio" : mimeType.startsWith("video/") ? "video" : "image";
}

export type MarkdownImageSource =
  | { _tag: "Direct"; uri: string }
  | { _tag: "WorkspaceFile"; path: string }
  | { _tag: "Blocked" };

const DIRECT_IMAGE_SOURCE_PATTERN = /^(?:https?:|data:|blob:|\/\/)/i;
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function markdownImageSourceFragment(source: string): string {
  return splitMarkdownLinkSearchAndHash(normalizeMarkdownLinkDestination(source)).hash;
}

function joinWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const separator = isWindowsAbsolutePath(workspaceRoot) ? "\\" : "/";
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  const path = relativePath.replace(/[\\/]/g, separator).replace(/^[\\/]+/, "");
  return `${root}${separator}${path}`;
}

/** Rendering is not a click, so a network path loads only from the project's own share. */
function hostFileSource(path: string, workspaceRoot: string | null | undefined): MarkdownImageSource {
  return isNetworkPath(path) && workspaceRelativeFilePath(path, workspaceRoot) === null ? { _tag: "Blocked" } : { _tag: "WorkspaceFile", path };
}

/** The destination a markdown file URL or path names on the host, before workspace resolution. */
function markdownDestinationHostPath(source: string): string | null {
  if (/^file:/i.test(source)) {
    const target = parseFileUrlHref(source);
    return target === null ? null : stripSlashPrefixedWindowsDrive(safeDecodeURIComponent(target.path));
  }
  return stripSlashPrefixedWindowsDrive(safeDecodeURIComponent(splitMarkdownLinkSearchAndHash(source).path));
}

/**
 * Filesystem paths belong to the environment host and never reach an image component without first becoming a signed
 * asset URL: a Direct source loads as it is, a WorkspaceFile one through the asset route, Blocked ones not at all.
 */
export function classifyMarkdownImageSource(value: string | null | undefined, workspaceRoot?: string | null): MarkdownImageSource {
  if (value === null || value === undefined) return { _tag: "Blocked" };
  const source = normalizeMarkdownLinkDestination(value);
  if (source.length === 0 || source.startsWith("#") || source.startsWith("?")) return { _tag: "Blocked" };
  if (DIRECT_IMAGE_SOURCE_PATTERN.test(source)) return { _tag: "Direct", uri: source };
  const path = markdownDestinationHostPath(source);
  if (path === null) return { _tag: "Blocked" };
  if (/^file:/i.test(source)) return hostFileSource(path, workspaceRoot);
  if (path.length === 0) return { _tag: "Blocked" };
  if (path.startsWith("/") || isWindowsAbsolutePath(path)) return hostFileSource(path, workspaceRoot);
  if (URI_SCHEME_PATTERN.test(path) || path.startsWith("~/") || path.startsWith("~\\")) return { _tag: "Blocked" };
  if (!workspaceRoot) return { _tag: "Blocked" };
  return { _tag: "WorkspaceFile", path: joinWorkspacePath(workspaceRoot, path) };
}

/** A protocol-relative media URL loads over https. */
export const resolveProtocolRelativeMediaUrl = (url: string): string => (url.startsWith("//") ? `https:${url}` : url);

/** The markdown a copy of the media writes: `![alt](src "title")`. */
export function markdownImageCopy(alt: string, src: string, title: string | undefined): string {
  const escapedAlt = alt.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
  const titleSuffix = title === undefined ? "" : ` "${title.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return `![${escapedAlt}](${src}${titleSuffix})`;
}

/** Media never draws wider than 30rem (480) or taller than 30rem. */
export const MEDIA_MAX = 480;

/** The box an image asks for (`width` / `height`, points or "50%") bounded to 30rem, keeping its aspect when only one side is given. */
export function authoredImageSize(
  width: number | `${number}%` | undefined,
  height: number | `${number}%` | undefined,
): { width?: number; height?: number } {
  const w = typeof width === "number" && Number.isFinite(width) && width > 0 ? width : undefined;
  const h = typeof height === "number" && Number.isFinite(height) && height > 0 ? height : undefined;
  if (w !== undefined && h !== undefined) {
    const scale = Math.min(1, MEDIA_MAX / w, MEDIA_MAX / h);
    return { width: Math.round(w * scale), height: Math.round(h * scale) };
  }
  if (w !== undefined) return { width: Math.min(w, MEDIA_MAX) };
  if (h !== undefined) return { height: Math.min(h, MEDIA_MAX) };
  return {};
}

/** The size an image draws at: its natural size, scaled down to fit 30rem each way (never up). */
export function fitMedia(natural: { width: number; height: number } | null, authored: { width?: number; height?: number } = {}): { width: number; height: number } | null {
  if (!natural || natural.width <= 0 || natural.height <= 0) return null;
  let width = natural.width;
  let height = natural.height;
  if (authored.width !== undefined && authored.height !== undefined) { width = authored.width; height = authored.height; }
  else if (authored.width !== undefined) { width = authored.width; height = (natural.height * authored.width) / natural.width; }
  else if (authored.height !== undefined) { height = authored.height; width = (natural.width * authored.height) / natural.height; }
  const scale = Math.min(1, MEDIA_MAX / width, MEDIA_MAX / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** The reference's unavailable line: `Image unavailable · alt · detail`. */
export function mediaUnavailableText(kind: MediaKind, alt: string, detail?: string): string {
  const label = kind === "audio" ? "Audio unavailable" : kind === "video" ? "Video unavailable" : "Image unavailable";
  return [label, alt, detail].filter(Boolean).join(" · ");
}

/** The name an expanded preview shows for an image: its alt text, else "image". */
export const mediaPreviewName = (alt: string | undefined, kind: MediaKind = "image"): string => (alt ?? "").trim() || kind;

/** The file name of an audio source (path or URL), else the alt, else "Audio". */
export function mediaFileName(source: string, alt: string, fallback = "Audio"): string {
  const name = (source.split(/[?#]/, 1)[0] ?? "").split(/[\\/]/).at(-1) ?? "";
  return safeDecodeURIComponent(name) || alt || fallback;
}

/** What a markdown image source resolves to: its kind, and where to load it from (null: nothing may load it). */
export interface ResolvedMedia { kind: MediaKind; source: MediaSource | null; blocked: boolean; /** A host file whose type is no media: it shows as a file chip. */ plainFile: boolean }

export function resolveMarkdownMedia(src: string, cwd: string | null, threadId: string | null): ResolvedMedia {
  const classified = classifyMarkdownImageSource(src, cwd);
  const mediaKind = mediaKindFromPath(src);
  const kind: MediaKind = mediaKind ?? "image";
  if (classified._tag === "Direct") return { kind, source: { kind: "url", url: resolveProtocolRelativeMediaUrl(classified.uri) }, blocked: false, plainFile: false };
  if (classified._tag === "WorkspaceFile") return { kind, source: threadId ? { kind: "file", path: classified.path, threadId } : null, blocked: false, plainFile: mediaKind === null };
  return { kind, source: null, blocked: true, plainFile: false };
}

function imagesIn(content: readonly TextViewInline[], out: TextViewImage[]) {
  for (const node of content) {
    if (node.type === "image") out.push(node);
    else if (node.type === "link") imagesIn(node.content, out);
    else if ("content" in node && Array.isArray(node.content)) imagesIn(node.content, out);
  }
}

/** The images and videos of a message in reading order: the set Previous / Next steps through (markdownImageGallery.ts). */
export function collectMarkdownGallery(blocks: readonly TextViewBlock[], cwd: string | null, threadId: string | null): ExpandedMediaItem[] {
  const images: TextViewImage[] = [];
  const visit = (list: readonly TextViewBlock[]) => {
    for (const block of list) {
      if (block.type === "paragraph" || block.type === "heading") imagesIn(block.content, images);
      else if (block.type === "blockquote") visit(block.children);
      else if (block.type === "list") for (const item of block.items) visit(item.children);
      else if (block.type === "details") visit(block.children);
      else if (block.type === "table") for (const row of block.rows ?? []) for (const cell of row) imagesIn(cell.content, images);
    }
  };
  visit(blocks);
  const items: ExpandedMediaItem[] = [];
  for (const image of images) {
    const resolved = resolveMarkdownMedia(image.src, cwd, threadId);
    if (resolved.kind === "audio" || resolved.source === null || resolved.plainFile) continue;
    items.push({ name: mediaPreviewName(image.alt, resolved.kind), kind: resolved.kind, source: resolved.source });
  }
  return items;
}

/** The index of an image's media among the gallery's items (matched by source), or -1. */
export function galleryIndexOf(items: readonly ExpandedMediaItem[], source: MediaSource | null): number {
  if (source === null) return -1;
  return items.findIndex((item) => (item.source.kind === "url" && source.kind === "url" ? item.source.url === source.url : item.source.kind === "file" && source.kind === "file" && item.source.path === source.path));
}
