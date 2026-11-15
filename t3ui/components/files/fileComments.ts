// fileCommentAnnotations.ts + reviewCommentContext.ts buildFileReviewComment: a comment on lines of a file preview becomes a
// `review-comment` context record ("File comment") the composer sends with the next message.
import { contextMarker, toComposerContextId } from "../composer/contextChips";

export interface FileComment { id: string; startLine: number; endLine: number; text: string }

let sequence = 0;
/** nextFileCommentId. */
export function nextFileCommentId(): string {
  sequence += 1;
  return `file-comment-${Date.now()}-${sequence}`;
}

/** formatFileCommentRange: "L12" or "L12 to L15". */
export function formatFileCommentRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `L${startLine}` : `L${startLine} to L${endLine}`;
}

/** inferReviewCommentFenceLanguage: the file's extension, a dotfile's name, else "text". */
export function inferFenceLanguage(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1);
  if (name.startsWith(".") && name.length > 1) return name.slice(1);
  return "text";
}

/** buildFileReviewComment as the composer's context record. */
export function fileReviewCommentRecord(comment: FileComment, filePath: string, contents: string) {
  const startLine = Math.max(1, Math.min(comment.startLine, comment.endLine));
  const endLine = Math.max(startLine, Math.max(comment.startLine, comment.endLine));
  const rangeLabel = formatFileCommentRange(startLine, endLine);
  const name = filePath.split(/[\\/]/).at(-1) ?? filePath;
  return {
    version: 1 as const,
    contextId: toComposerContextId(`review-comment_${comment.id}`),
    kind: "review-comment" as const,
    label: `${name} ${rangeLabel}`.slice(0, 200),
    sectionId: `file:${filePath}`,
    sectionTitle: "File comment",
    filePath,
    startIndex: startLine - 1,
    endIndex: endLine - 1,
    rangeLabel,
    text: comment.text.trim(),
    diff: contents.split("\n").slice(startLine - 1, endLine).join("\n"),
    fenceLanguage: inferFenceLanguage(filePath),
  };
}

export const fileReviewCommentMarker = (record: ReturnType<typeof fileReviewCommentRecord>) => contextMarker("review-comment", record.contextId, record.label);
