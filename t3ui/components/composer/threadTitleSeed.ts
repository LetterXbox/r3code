// client-runtime operations/threadTitle.ts deriveThreadTitleSeed and ChatView.logic sendTitleFallbackLabels:
// the title a new thread starts with, from the prompt's prose (context chips read as their labels), else its
// images or first file, else the first terminal, review comment or preview annotation context.
const CONTEXT_REFERENCE = /!?\[((?:\\.|[^\]\\]){0,200})\]\(t3-context:\/\/v1\/([a-z-]+)\/[A-Za-z0-9_-]{1,128}\)/g;

export function truncateTitle(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  const characters = Array.from(trimmed);
  return characters.length <= maxLength ? trimmed : `${characters.slice(0, maxLength).join("")}...`;
}

const normalize = (value: string) => value.trim().replace(/\s+/gu, " ");

export function threadTitleTextFromPrompt(value: string): string {
  const imageIds = new Set<string>();
  const prose = value.replace(CONTEXT_REFERENCE, (whole, label: string, kind: string) => {
    if (kind === "image") { imageIds.add(whole); return ""; }
    return label.replace(/\\(.)/g, "$1");
  });
  return normalize(prose) || (imageIds.size > 0 ? (imageIds.size === 1 ? "Attached image" : "Attached images") : "");
}

export function deriveThreadTitleSeed(input: { text: string; attachments: ReadonlyArray<{ kind: string; name: string }>; fallbackLabels?: ReadonlyArray<string | null | undefined> }): string {
  const text = threadTitleTextFromPrompt(input.text);
  if (text.length > 0) return truncateTitle(text);
  const images = input.attachments.filter((attachment) => attachment.kind === "image");
  if (images.length > 0) return images.length === 1 ? "Attached image" : "Attached images";
  const attachmentName = normalize(input.attachments[0]?.name ?? "");
  if (attachmentName.length > 0) return truncateTitle(`File: ${attachmentName}`);
  for (const label of input.fallbackLabels ?? []) {
    const normalized = normalize(label ?? "");
    if (normalized.length > 0) return truncateTitle(normalized);
  }
  return "New thread";
}

/** sendTitleFallbackLabels over the port's context records. */
export function sendTitleFallbackLabels(records: ReadonlyArray<{ kind: string; label: string }>): (string | undefined)[] {
  const first = (kind: string) => records.find((record) => record.kind === kind)?.label;
  const review = first("review-comment");
  return [first("terminal"), review ? `Review: ${review}` : undefined, first("preview-annotation")];
}
