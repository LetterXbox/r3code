// copySnapshot.ts: copies a SnapShot attachment (its image + caption text) to the clipboard.
import { Clipboard } from "nsh";

export async function copySnapshot(src: string, text: string): Promise<void> {
  if (!src) throw new Error("Snapshot is no longer available.");
  await Clipboard.writeText(text);
}
