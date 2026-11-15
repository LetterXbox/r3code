// MediaActions "Save image / Save video" and "Copy image" (apps/web/src/components/media/MediaActions.tsx, mediaContent.ts),
// with the reference's error copy. A browser download becomes a file in ~/Downloads; the clipboard takes the image as a
// base64 data URL (Clipboard.writeImage).
import { Clipboard } from "nsh";
import { stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { MEDIA_IMAGE_BYTES, MEDIA_PLAYER_BYTES, readMediaFile } from "./markdownAsset";
import type { MediaSource } from "./mediaSources";

export interface MediaBytes { bytes: Uint8Array; mimeType: string }

const MIME_BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" };
export const mimeForName = (name: string) => MIME_BY_EXT[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

function decodePercentBytes(payload: string): Uint8Array {
  const encoder = new TextEncoder();
  return Uint8Array.from(payload.split(/(%[0-9a-f]{2})/i).flatMap((part) => (/^%[0-9a-f]{2}$/i.test(part) ? [Number.parseInt(part.slice(1), 16)] : [...encoder.encode(part)])));
}

/** readDataUrlBlob. */
export function readDataUrl(src: string): MediaBytes {
  const url = src.split("#", 1)[0] ?? src;
  const comma = url.indexOf(",");
  const [mimeType = "", ...parameters] = url.slice("data:".length, comma).split(";");
  const payload = url.slice(comma + 1);
  try {
    if (comma < 0) throw new Error("Missing data URL payload.");
    const isBase64 = parameters.some((parameter) => parameter.trim().toLowerCase() === "base64");
    const bytes = isBase64 ? Uint8Array.from(atob(decodeURIComponent(payload)), (char) => char.charCodeAt(0)) : decodePercentBytes(payload);
    return { bytes, mimeType: mimeType || "text/plain" };
  } catch {
    throw new Error("This inline media could not be decoded.");
  }
}

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>;

/** readMediaBlob for a URL: fetch, HTTP status copy, and the web-page-instead-of-media guard. */
export async function readMediaUrl(src: string, fetcher: Fetcher = fetch as unknown as Fetcher): Promise<MediaBytes> {
  if (/^data:/i.test(src)) return readDataUrl(src);
  const response = await fetcher(src).catch(() => null);
  if (!response) throw new Error("The file could not be fetched. Check the connection and try again.");
  if (!response.ok) throw new Error(`The file could not be fetched (HTTP ${response.status}).`);
  const mimeType = response.headers.get("content-type") ?? "";
  if (mimeType.split(";", 1)[0]?.trim() === "text/html") throw new Error("This link returned a web page instead of media. Open the original URL.");
  return { bytes: new Uint8Array(await response.arrayBuffer()), mimeType: mimeType || mimeForName(src) };
}

export async function readMediaSource(source: MediaSource | null, kind: "image" | "video"): Promise<MediaBytes> {
  if (!source) throw new Error("This media is unavailable. Try reopening the preview.");
  if (source.kind === "url") return readMediaUrl(source.url);
  const controller = new AbortController();
  const blob = await readMediaFile(source.threadId, source.path, { signal: controller.signal, maxBytes: kind === "image" ? MEDIA_IMAGE_BYTES : MEDIA_PLAYER_BYTES })
    .catch(() => { throw new Error("Reconnect to this environment and try again."); });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: mimeForName(source.path) };
}

/** The download's file name in ~/Downloads, numbered like a browser when the name is taken. */
export async function freeDownloadPath(directory: string, name: string, exists: (path: string) => Promise<boolean>): Promise<string> {
  const safe = name.replace(/[/\\]/g, "_") || "media";
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  for (let index = 0; index < 1000; index += 1) {
    const candidate = join(directory, index === 0 ? safe : `${stem} (${index})${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error("The media action failed.");
}

export async function saveMedia(source: MediaSource | null, kind: "image" | "video", name: string): Promise<string> {
  const media = await readMediaSource(source, kind);
  const path = await freeDownloadPath(join(homedir(), "Downloads"), name, (candidate) => stat(candidate).then(() => true, () => false));
  await writeFile(path, media.bytes);
  return path;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export async function copyMediaImage(source: MediaSource | null): Promise<void> {
  const media = await readMediaSource(source, "image");
  if (!media.mimeType.startsWith("image/")) throw new Error("This link returned a web page instead of media. Open the original URL.");
  await Clipboard.writeImage(`data:${media.mimeType};base64,${base64(media.bytes)}`)
    .catch(() => { throw new Error("Image copying is unavailable. Use a secure browser connection or save the image."); });
}

/** OpenMediaLink: what the unavailable-video and expanded-image states offer for a web source. Null when the source is
 * not http(s) (a blob would be "Download video", which this app's file-backed media never has). */
export function openMediaLink(input: { originalUrl?: string; src?: string | null }): { label: string; url: string } | null {
  const isWeb = (value: string | undefined | null) => { try { return value ? /^https?:$/.test(new URL(value).protocol) : false; } catch { return false; } };
  const originalUrl = isWeb(input.originalUrl) ? input.originalUrl! : undefined;
  const source = originalUrl ?? input.src;
  if (!source) return null;
  const url = source.startsWith("//") ? `https:${source}` : source;
  if (!isWeb(url)) return null;
  return { label: originalUrl ? "Open original" : "Open in browser", url };
}
