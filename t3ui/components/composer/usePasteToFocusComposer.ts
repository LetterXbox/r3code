// chat/usePasteToFocusComposer.ts: the resting composer is unfocused after a click into the transcript, so a paste
// that follows has no editable target. The paste chord (bound by bindTypeToFocus while nothing is focused) reads
// the clipboard here and hands text to the composer and files to its attachments.
import { Clipboard } from "nsh";

export interface PasteTarget {
  insertText: (text: string) => void;
  attachPaths: (uris: string[]) => void;
  attachFiles: (files: File[]) => void;
  /** The conversation which received the paste is still selected. */
  isCurrent?: () => boolean;
}

/** pasteTextToFocusComposer: files go to attachments, otherwise the clipboard's text is inserted at the end. */
export async function pasteIntoComposer(target: PasteTarget, readers: { files: () => Promise<string[]>; text: () => Promise<string>; image?: () => Promise<File | null> } = { files: () => Clipboard.readFiles(), text: () => Clipboard.readText(), image: async () => {
  const image = await Clipboard.readImage();
  if (!image) return null;
  const blob = await (await fetch(image.url)).blob();
  const extension = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : blob.type === "image/gif" ? "gif" : blob.type === "image/bmp" ? "bmp" : "png";
  return new File([blob], `image.${extension}`, { type: blob.type || "image/png" });
} }): Promise<boolean> {
  let files: string[] = [];
  try { files = await readers.files(); } catch { /* a platform without file clipboards */ }
  if (target.isCurrent?.() === false) return false;
  if (files.length > 0) { target.attachPaths(files); return true; }
  let image: File | null = null;
  try { image = await readers.image?.() ?? null; } catch { /* a platform without image clipboards */ }
  if (target.isCurrent?.() === false) return false;
  if (image) { target.attachFiles([image]); return true; }
  let text = "";
  try { text = await readers.text(); } catch { /* unreadable clipboard */ }
  if (target.isCurrent?.() === false || text.length === 0) return false;
  target.insertText(text);
  return true;
}
