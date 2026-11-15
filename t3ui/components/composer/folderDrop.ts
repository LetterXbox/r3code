// Folders dropped or pasted into the composer (folderDrop.ts, useComposerAttachmentIntake): a folder is not
// attached, it becomes a `@folder` mention (the markdown file link a pick from the `@` menu writes) at the end
// of the prompt, and only when the server runs on this computer (it must read the same path).
import { stat } from "fs/promises";
import { serializeComposerFileLink } from "./editor/promptDocument";

export const REMOTE_FOLDER_MESSAGE = "Folders can only be referenced on a server running on this computer";

/** The local path of a `file:` URL, or a plain absolute path as is; null for anything else. */
export function fileUriToPath(uri: string): string | null {
  if (uri.startsWith("/")) return uri;
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) return null;
    const path = decodeURIComponent(url.pathname);
    return path.length > 0 ? path : null;
  } catch { return null; }
}

/** folderDropTarget: a server on a loopback address shares this computer's filesystem. */
export function isLocalServer(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || host === "127.0.0.1" || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch { return false; }
}

const isDirectoryOnDisk = async (path: string) => { try { return (await stat(path)).isDirectory(); } catch { return false; } };

/** Splits dropped URIs into the files to attach (as given) and the folders to mention (by path). */
export async function splitDroppedUris(uris: readonly string[], isDirectory: (path: string) => Promise<boolean> = isDirectoryOnDisk): Promise<{ files: string[]; folders: string[] }> {
  const files: string[] = [];
  const folders: string[] = [];
  for (const uri of uris) {
    const path = fileUriToPath(uri);
    if (path !== null && await isDirectory(path)) folders.push(path.replace(/\/+$/, "") || "/");
    else files.push(uri);
  }
  return { files, folders };
}

/** The prompt with each folder's mention appended (ensureLeadingBoundary: one space before, one after), and the sources added. */
export function promptWithFolders(prompt: string, folders: readonly string[]): { text: string; sources: string[] } {
  let text = prompt;
  const sources: string[] = [];
  for (const folder of folders) {
    const source = serializeComposerFileLink(folder);
    if (text.includes(`${source} `) || text.endsWith(source)) continue;
    sources.push(source);
    text = `${text}${text.length === 0 || /\s$/.test(text) ? "" : " "}${source} `;
  }
  return { text, sources };
}
