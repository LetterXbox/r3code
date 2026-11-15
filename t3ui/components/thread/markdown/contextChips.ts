import { token } from "nsh";
import { parseColor } from "../../composer/tokenColor";
import { accentInkOnAll } from "../../composer/editor/chipColors";
// UserMessageContextChips.tsx: a user message's text references its composer context as
// `[label](t3-context://v1/<kind>/<id>)` links; the message's `context.records` carry the data.
// Pure helpers: read the records, and turn the links into marker text the markdown view renders as chips.

export interface ContextChipRecord {
  contextId: string;
  kind: string;
  label: string;
  /** mention: the workspace path. */
  path?: string;
  /** thread: the linked thread. */
  threadId?: string;
  environmentId?: string;
  /** skill: its name. */
  name?: string;
  /** terminal: the terminal's label, the captured line range and output (TerminalContextInlineChip). */
  terminalLabel?: string;
  lineStart?: number;
  lineEnd?: number;
  text?: string;
  /** review-comment (UserMessageReviewCommentCard): where the comment sits and what it quotes. */
  sectionTitle?: string;
  filePath?: string;
  rangeLabel?: string;
  diff?: string;
  fenceLanguage?: string;
  /** review-comment carrying PR metadata (a pull-request chip, not a comment card). */
  hasPullRequest?: boolean;
  /** PullRequestContextMetadata of a pull-request summary (UserMessagePullRequestContextChip). */
  pullRequest?: PullRequestChipMetadata;
  /** preview-annotation (UserMessagePreviewAnnotationDetails). */
  annotationId?: string;
  pageUrl?: string;
  pageTitle?: string | null;
  comment?: string;
  targetSummary?: string;
  styleChangeCount?: number;
  annotationElements?: { tagName: string; selector: string | null; htmlPreview: string; sourceLabel: string | null }[];
  screenshotContextId?: string;
  /** image / file: the attachment the record names. */
  attachmentId?: string;
  /** image / file: the matching message attachment, when still available. */
  attachment?: { id: string; name: string; mimeType: string; sizeBytes: number; type: string };
  /** preview-annotation: its screenshot among the message's images (resolvePreviewAnnotationImage). */
  annotationImage?: { id: string; name: string; mimeType: string; sizeBytes: number; type: string };
}

type ChipImage = NonNullable<ContextChipRecord["annotationImage"]>;

/**
 * resolvePreviewAnnotationImage (TimelineUserMessageRow.logic.ts:9-28): the annotation's screenshot is the image its
 * screenshotContextId names, else the image named preview-annotation-<id>.png, else the preview image at the record's
 * place among the message's annotations.
 */
export function resolvePreviewAnnotationImage(input: { record: ContextChipRecord; recordsById: Record<string, ContextChipRecord>; userImages: readonly ChipImage[]; previewImages: readonly ChipImage[]; annotationRecordIds: readonly string[] }): ChipImage | null {
  const screenshot = input.record.screenshotContextId ? input.recordsById[input.record.screenshotContextId] : undefined;
  return (screenshot?.kind === "image" ? input.userImages.find((image) => image.id === screenshot.attachmentId) : undefined)
    ?? input.previewImages.find((image) => image.name === `preview-annotation-${input.record.annotationId}.png`)
    ?? input.previewImages[input.annotationRecordIds.indexOf(input.record.contextId)]
    ?? null;
}

/** Each preview-annotation record of a message gets its screenshot from the message's image attachments. */
export function withAnnotationImages(records: Record<string, ContextChipRecord>, attachments: readonly ChipImage[]): Record<string, ContextChipRecord> {
  const images = attachments.filter((item) => item.type === "image" || item.mimeType.startsWith("image/"));
  const previewImages = images.filter((image) => /^preview-annotation-.+\.png$/.test(image.name));
  const annotationRecordIds = Object.values(records).filter((record) => record.kind === "preview-annotation").map((record) => record.contextId);
  const out: Record<string, ContextChipRecord> = { ...records };
  for (const record of Object.values(records)) {
    if ((record.kind !== "image" && record.kind !== "file") || !record.attachmentId) continue;
    const attachment = attachments.find((item) => item.id === record.attachmentId);
    if (attachment) out[record.contextId] = { ...record, attachment, ...(record.kind === "image" ? { annotationImage: attachment } : {}) };
  }
  for (const id of annotationRecordIds) {
    const image = resolvePreviewAnnotationImage({ record: records[id]!, recordsById: records, userImages: images, previewImages, annotationRecordIds });
    if (image) out[id] = { ...records[id]!, annotationImage: image };
  }
  return out;
}

export interface PullRequestChipMetadata { number: number; title: string; url: string; state: string; isDraft: boolean; headBranch: string; baseBranch: string }

/** composerContextRecords pullRequestContextDisplayState. */
export function pullRequestDisplayState(pullRequest: Pick<PullRequestChipMetadata, "state" | "isDraft">): "open" | "draft" | "merged" | "closed" {
  if (pullRequest.state === "open") return pullRequest.isDraft ? "draft" : "open";
  return pullRequest.state === "merged" ? "merged" : pullRequest.state === "closed" ? "closed" : "open";
}

/** contextChipParts PULL_REQUEST_CHIP_KINDS: the chip's accent by state. */
export const pullRequestChipKind = (pullRequest: Pick<PullRequestChipMetadata, "state" | "isDraft">) => `pr-${pullRequestDisplayState(pullRequest)}`;

/** pullRequestContextKindLabel: "<State> pull request" (a GitLab URL names a merge request). */
export function pullRequestKindLabel(pullRequest: Pick<PullRequestChipMetadata, "state" | "isDraft" | "url">): string {
  const term = /gitlab/i.test(pullRequest.url) ? "merge request" : "pull request";
  const state = pullRequestDisplayState(pullRequest);
  return `${state.charAt(0).toUpperCase()}${state.slice(1)} ${term}`;
}

function readPullRequest(value: unknown): PullRequestChipMetadata | undefined {
  const pr = object(value);
  if (!pr || typeof pr.number !== "number" || typeof pr.url !== "string") return undefined;
  return { number: pr.number, title: typeof pr.title === "string" ? pr.title : "", url: pr.url, state: typeof pr.state === "string" ? pr.state : "open", isDraft: pr.isDraft === true,
    headBranch: typeof pr.headBranch === "string" ? pr.headBranch : "", baseBranch: typeof pr.baseBranch === "string" ? pr.baseBranch : "" };
}

/** The accent per kind (lib/contextChipAccents.ts), as OKLCH lightness, chroma and hue. */
export const CONTEXT_CHIP_ACCENTS: Record<string, readonly [number, number, number]> = {
  image: [0.62, 0.136, 237], video: [0.62, 0.16, 48], file: [0.62, 0.136, 237], mention: [0.62, 0.11, 215], terminal: [0.62, 0.134, 163],
  element: [0.62, 0.134, 70], "preview-annotation": [0.62, 0.134, 70], "review-comment": [0.62, 0.16, 292], "pull-request": [0.62, 0.16, 277],
  "pr-open": [0.62, 0.134, 163], "pr-draft": [0.62, 0.02, 259], "pr-merged": [0.62, 0.16, 292], "pr-closed": [0.62, 0.16, 16], skill: [0.62, 0.16, 322],
  model: [0.62, 0.13, 105], thread: [0.62, 0.12, 190], environment: [0.62, 0.11, 145], citation: [0.62, 0.16, 259], "doc-pdf": [0.62, 0.16, 24],
  "doc-word": [0.62, 0.136, 248], "doc-spreadsheet": [0.62, 0.134, 148], "doc-slides": [0.62, 0.134, 56], "doc-epub": [0.62, 0.16, 291],
};

const DOCUMENT_CHIP_KIND_BY_EXTENSION: Record<string, string> = {
  pdf: "doc-pdf", doc: "doc-word", docx: "doc-word", odt: "doc-word", rtf: "doc-word", xls: "doc-spreadsheet", xlsx: "doc-spreadsheet", ods: "doc-spreadsheet",
  csv: "doc-spreadsheet", tsv: "doc-spreadsheet", ppt: "doc-slides", pptx: "doc-slides", odp: "doc-slides", epub: "doc-epub",
};

/** pierre-icons.ts documentChipKindForFileName: a document file's chip takes its type's accent, anything else is a mention. */
export function documentChipKindForFileName(fileName: string): string | undefined {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? undefined : DOCUMENT_CHIP_KIND_BY_EXTENSION[fileName.slice(dot + 1).toLowerCase()];
}

/**
 * The kind's ink in the running theme (themePalette.ts contextChipVariables): the accent with its lightness solved for
 * 5:1 contrast on the canvas, surface and raised surface, so it is lighter on a dark theme and darker on a light one.
 */
export function chipColor(kind: string): string | null {
  const accent = CONTEXT_CHIP_ACCENTS[kind];
  if (!accent) return null;
  const surfaces = (["background", "card", "popover"] as const).map((name) => parseColor(token(name))).filter((value): value is [number, number, number] => value !== null);
  return accentInkOnAll(accent, surfaces.length ? surfaces : [[255, 255, 255]]);
}

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** Records of a message's `context`, by context id. Undecodable records are dropped, as the server's decoder does. */
export function parseContextRecords(context: unknown): Record<string, ContextChipRecord> {
  const records = object(context)?.records;
  const out: Record<string, ContextChipRecord> = {};
  if (!Array.isArray(records)) return out;
  for (const entry of records) {
    const record = object(entry);
    const contextId = text(record?.contextId);
    const kind = text(record?.kind);
    if (!record || !contextId || !kind) continue;
    out[contextId] = {
      contextId, kind, label: typeof record.label === "string" ? record.label : "",
      ...(text(record.path) ? { path: text(record.path) } : {}),
      ...(text(record.threadId) ? { threadId: text(record.threadId) } : {}),
      ...(text(record.environmentId) ? { environmentId: text(record.environmentId) } : {}),
      ...(text(record.name) ? { name: text(record.name) } : {}),
      ...(text(record.terminalLabel) ? { terminalLabel: text(record.terminalLabel) } : {}),
      ...(typeof record.lineStart === "number" ? { lineStart: record.lineStart } : {}),
      ...(typeof record.lineEnd === "number" ? { lineEnd: record.lineEnd } : {}),
      ...(typeof record.text === "string" ? { text: record.text } : {}),
      ...(text(record.sectionTitle) ? { sectionTitle: text(record.sectionTitle) } : {}),
      ...(text(record.filePath) ? { filePath: text(record.filePath) } : {}),
      ...(text(record.rangeLabel) ? { rangeLabel: text(record.rangeLabel) } : {}),
      ...(typeof record.diff === "string" ? { diff: record.diff } : {}),
      ...(text(record.fenceLanguage) ? { fenceLanguage: text(record.fenceLanguage) } : {}),
      ...(object(record.pullRequest) ? { hasPullRequest: true } : {}),
      ...(readPullRequest(record.pullRequest) ? { pullRequest: readPullRequest(record.pullRequest) } : {}),
      ...(text(record.attachmentId) ? { attachmentId: text(record.attachmentId) } : {}),
      ...(kind === "preview-annotation" ? readPreviewAnnotation(record) : {}),
    };
  }
  return out;
}

function readPreviewAnnotation(record: Record<string, unknown>): Partial<ContextChipRecord> {
  const elements = Array.isArray(record.elements) ? record.elements.flatMap((entry) => {
    const el = object(entry);
    if (!el || typeof el.tagName !== "string") return [];
    const source = object(el.source);
    const fileName = typeof source?.fileName === "string" ? source.fileName : null;
    return [{ tagName: el.tagName, selector: typeof el.selector === "string" ? el.selector : null, htmlPreview: typeof el.htmlPreview === "string" ? el.htmlPreview : "",
      sourceLabel: fileName ? `${fileName}${typeof source?.lineNumber === "number" ? `:${source.lineNumber}` : ""}` : null }];
  }) : [];
  return {
    ...(text(record.annotationId) ? { annotationId: text(record.annotationId) } : {}),
    ...(typeof record.pageUrl === "string" ? { pageUrl: record.pageUrl } : {}),
    pageTitle: typeof record.pageTitle === "string" ? record.pageTitle : null,
    ...(typeof record.comment === "string" ? { comment: record.comment } : {}),
    ...(typeof record.targetSummary === "string" ? { targetSummary: record.targetSummary } : {}),
    styleChangeCount: Array.isArray(record.styleChanges) ? record.styleChanges.length : 0,
    annotationElements: elements,
    ...(text(record.screenshotContextId) ? { screenshotContextId: text(record.screenshotContextId) } : {}),
  };
}

const CONTEXT_LINK = /(!?)\[([^\]\n]{0,512})\]\(t3-context:\/\/v1\/([a-z][a-z0-9-]{0,39})\/([A-Za-z0-9_-]{1,128})\)/g;

/** File references that resolve to attachments, and the remaining message text. */
export function referencedFileAttachments(markdown: string, records: Record<string, ContextChipRecord>): { ids: Set<string>; remaining: string } {
  const ids = new Set<string>();
  const remaining = markdown.replace(CONTEXT_LINK, (whole, bang: string, _label: string, kind: string, id: string) => {
    const record = records[id];
    if (bang || kind !== "file" || record?.kind !== "file" || !record.attachment) return whole;
    ids.add(record.attachment.id);
    return "";
  });
  return { ids, remaining };
}

/** The pattern the markdown extension matches: ⟦kind|id|label⟧. */
export const CONTEXT_CHIP_PATTERN = "⟦([a-z][a-z0-9-]*)\\|([A-Za-z0-9_-]+)\\|([^⟧]*)⟧";

/** Replaces context references with chips; ordinary markdown images remain images. */
export function chipifyContextLinks(markdown: string): string {
  if (!markdown.includes("t3-context://")) return markdown;
  return markdown.replace(CONTEXT_LINK, (whole, bang: string, label: string, kind: string, id: string) =>
    bang && kind !== "image" ? whole : `⟦${kind}|${id}|${label.replace(/[⟦⟧|]/g, " ")}⟧`);
}

/** The label a chip shows: what the message wrote, else the record's own, else the kind. */
export function chipLabel(written: string, record: ContextChipRecord | undefined, kind: string): string {
  return written.trim() || record?.label.trim() || record?.name || record?.path?.split("/").pop() || kind;
}

/** TerminalContextInlineChip: "Line N" for one line, else "Lines a–b". */
export const terminalLineRange = (start: number, end: number) => (start === end ? `Line ${start}` : `Lines ${start}\u2013${end}`);

/** reviewCommentContext.ts buildReviewCommentRenderablePatch: a diff comment as a one-file git patch ("" for a file comment or no diff). */
export function buildReviewCommentRenderablePatch(comment: { filePath: string; diff: string; fenceLanguage?: string }): string {
  if ((comment.fenceLanguage ?? "diff") !== "diff") return "";
  if (comment.diff.trim().length === 0) return "";
  const diff = comment.diff.trimStart().replace(/\n+$/, "");
  if (diff.startsWith("diff --git ")) return diff;
  const path = comment.filePath.replaceAll("\\", "/");
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, diff].join("\n");
}
