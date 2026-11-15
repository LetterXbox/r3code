// The stack's file header (Pierre's createFileHeaderElement, styled by StyledDiffCodeView): a change
// icon by the file's change type (getIconForType), then for a rename the old path at 70% opacity, an
// arrow and the new path. A file whose patch has not loaded yet is "change", or "rename-changed" when
// the server's metadata names a previous path (useReviewFilePatches' pending entries); once loaded the
// patch's own "new file mode" / "deleted file mode" lines decide, as Pierre's parser does.
import type { ImageAsset } from "nsh";
import added from "./icons/symbol-added.svg";
import deleted from "./icons/symbol-deleted.svg";
import modified from "./icons/symbol-modified.svg";
import moved from "./icons/symbol-moved.svg";
import arrow from "./icons/arrow-right-short.svg";

export type HeaderChangeType = "new" | "deleted" | "change" | "rename";

export function headerChangeType(file: { path: string; previousPath: string | null }, patch: string | null): HeaderChangeType {
  const renamed = file.previousPath !== null && file.previousPath !== file.path;
  if (patch) {
    if (/^new file mode /m.test(patch)) return "new";
    if (/^deleted file mode /m.test(patch)) return "deleted";
  }
  return renamed ? "rename" : "change";
}

/** The old path to show before the arrow, or null (only a rename has one: Pierre's prevName). */
export function headerPreviousPath(file: { path: string; previousPath: string | null }): string | null {
  return file.previousPath !== null && file.previousPath !== file.path ? file.previousPath : null;
}

export const HEADER_ICON: Record<HeaderChangeType, ImageAsset> = { new: added, deleted, change: modified, rename: moved };
export const RENAME_ARROW: ImageAsset = arrow;
