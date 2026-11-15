// "Annotate preview" (PreviewChromeRow.tsx / PreviewView.tsx handlePickElement): the annotation layer runs in the page
// (previewPickPage.ts, the port of PickPreload.ts startAnnotation). Its submitted PreviewAnnotationPayload becomes a
// `preview-annotation` composer context (composerDraftStore addPreviewAnnotation + composerContextRecords
// previewAnnotationContextRecord): the record joins the thread's context and its token goes into the prompt.
import { colorScheme, host, token } from "nsh";
import { addAttachment, backendStatus, draftAttachments, isSending, openThread, sendDraft, threadUserInputs } from "../../store";
import { showToast } from "../toast";
import { attachExtraContext, extraContextMarker, sanitizeContextLabel, toComposerContextId, type PreviewAnnotationContextRecord } from "../composer/contextChips";
import { placeContextReference } from "../composer/terminalContext";
import { tokenAlpha } from "../composer/tokenColor";
import { installPreviewPick } from "./previewPickPage";
import { INSTALL_PREVIEW_PICK_SOURCE } from "./previewPickPage.generated";

export { installPreviewPick };

export interface AnnotationTheme {
  primary?: string; primaryFill?: string; regionFill?: string; primaryForeground?: string; popover?: string; popoverForeground?: string;
  foreground?: string; mutedForeground?: string; border?: string; accent?: string; fontSans?: string;
}

/** DesktopPreviewAnnotationTheme: the app's colours, so the page's layer matches the app (applyAnnotationTheme). */
export function annotationTheme(): AnnotationTheme {
  const t = (name: string, alpha = 1) => { try { return tokenAlpha(name as never, alpha); } catch { return undefined; } };
  void colorScheme();
  void token;
  return {
    primary: t("primary"), primaryFill: t("primary", 0.1), regionFill: t("primary", 0.06), primaryForeground: t("primary-foreground"),
    popover: t("popover"), popoverForeground: t("popover-foreground"), foreground: t("foreground"), mutedForeground: t("muted-foreground"),
    border: t("border"), accent: t("accent"),
  };
}

/** The script that starts (or, run again, cancels) annotation in the page. */
export function previewPickScript(options: { sendEnabled: boolean; theme?: AnnotationTheme; voice?: boolean; voiceShortcuts?: string[]; voiceShortcutLabel?: string | null }): string {
  const cfg = JSON.stringify({ sendEnabled: options.sendEnabled, theme: options.theme ?? {}, voice: options.voice === true, voiceShortcuts: options.voiceShortcuts ?? [], voiceShortcutLabel: options.voiceShortcutLabel ?? null }).replace(/</g, "\\u003c");
  return `(${INSTALL_PREVIEW_PICK_SOURCE})(${cfg},{window:window,document:document});true;`;
}

export interface PreviewAnnotationPayload {
  id: string; pageUrl: string; pageTitle: string | null; comment: string;
  elements: { id: string; element: { pageUrl: string; pageTitle: string | null; tagName: string; selector: string | null; htmlPreview: string; componentName: string | null; source: null | { functionName?: string | null; fileName?: string | null; lineNumber?: number | null; columnNumber?: number | null }; stack: unknown[]; styles: string; pickedAt: string }; rect: { x: number; y: number; width: number; height: number } }[];
  regions: { id: string; rect: { x: number; y: number; width: number; height: number } }[];
  strokes: { id: string; color: string; width: number; points: { x: number; y: number }[]; bounds: { x: number; y: number; width: number; height: number } }[];
  styleChanges: { targetId: string; selector: string | null; property: string; previousValue: string; value: string }[];
  screenshot: null | { dataUrl: string; width: number; height: number; cropRect: PreviewAnnotationRect };
  createdAt: string;
}

export interface PreviewAnnotationRect { x: number; y: number; width: number; height: number }
export type PickMessage = { annotation: PreviewAnnotationPayload; submission: "attach" | "send"; screenshotRect?: PreviewAnnotationRect | null } | "cancelled";

/** The page's `{t3:"pick"}` message, or null when it is not one. */
export function readPickMessage(data: string): PickMessage | null {
  let m: { t3?: unknown; cancelled?: unknown; annotation?: unknown; submission?: unknown };
  try { m = JSON.parse(data); } catch { return null; }
  if (m?.t3 !== "pick") return null;
  if (m.cancelled === true) return "cancelled";
  const a = m.annotation as PreviewAnnotationPayload | undefined;
  if (!a || typeof a.id !== "string" || typeof a.pageUrl !== "string" || !Array.isArray(a.elements)) return null;
  const r = (m as { screenshotRect?: Partial<PreviewAnnotationRect> | null }).screenshotRect;
  const screenshotRect = r && [r.x, r.y, r.width, r.height].every((v) => typeof v === "number" && Number.isFinite(v)) && r.width! > 0 && r.height! > 0
    ? { x: r.x!, y: r.y!, width: r.width!, height: r.height! } : null;
  return { annotation: a, submission: m.submission === "send" ? "send" : "attach", screenshotRect };
}

/** The script that tells the page its marks were captured, so the annotation layer goes (ANNOTATION_CAPTURED_CHANNEL). */
export const PICK_CAPTURED_SCRIPT = "window.__t3pick && window.__t3pick.captured && window.__t3pick.captured();true;";

export type CaptureCall = (data: { point?: { x: number; y: number }; rect: PreviewAnnotationRect }) => Promise<unknown>;

/** The host's `webview.capture` (patch 0015); a host without it rejects. */
export const hostCapture: CaptureCall = (data) => host.call("webview.capture", data);

/**
 * PreviewManager captureAnnotationScreenshot + cropAnnotationScreenshot: the page's marked area as a PNG, from the host's
 * snapshot of the web view (the page's own pixels, the marks included). Null when there is nothing to crop or the host
 * cannot capture: the annotation is then kept without it.
 */
export async function captureAnnotationScreenshot(rect: PreviewAnnotationRect | null | undefined, point: { x: number; y: number } | null, capture: CaptureCall = hostCapture): Promise<PreviewAnnotationPayload["screenshot"]> {
  if (!rect) return null;
  try {
    const result = await capture({ ...(point ? { point } : {}), rect });
    const r = result as { dataUrl?: unknown; width?: unknown; height?: unknown } | null;
    if (!r || typeof r.dataUrl !== "string" || !r.dataUrl.startsWith("data:image/png;base64,") || typeof r.width !== "number" || typeof r.height !== "number" || r.width <= 0 || r.height <= 0) return null;
    return { dataUrl: r.dataUrl, width: r.width, height: r.height, cropRect: { ...rect } };
  } catch {
    return null;
  }
}

/** capturePreviewAnnotationScreenshot (lib/previewAnnotation.ts): the screenshot as the file the composer attaches. */
export function annotationScreenshotFile(annotation: PreviewAnnotationPayload): File | null {
  const shot = annotation.screenshot;
  if (!shot) return null;
  try {
    const bytes = Uint8Array.from(atob(shot.dataUrl.slice("data:image/png;base64,".length)), (c) => c.charCodeAt(0));
    return new File([bytes], `preview-annotation-${annotation.id}.png`, { type: "image/png" });
  } catch {
    return null;
  }
}

/**
 * PreviewView.tsx handlePickElement after a submit: the annotation joins the composer, its screenshot as an image
 * attachment; a capture that failed keeps the annotation without it and says so.
 */
export async function submitPickedAnnotation(picked: { annotation: PreviewAnnotationPayload; submission: "attach" | "send"; screenshotRect?: PreviewAnnotationRect | null }, point: { x: number; y: number } | null,
  deps: { capture?: CaptureCall; attach?: (file: File) => Promise<void>; captured?: () => void } = {}): Promise<void> {
  const screenshot = await captureAnnotationScreenshot(picked.screenshotRect, point, deps.capture);
  deps.captured?.();
  const annotation = { ...picked.annotation, screenshot };
  if (picked.screenshotRect !== undefined && screenshot === null) {
    showToast({ type: "error", title: "Could not capture the picked element", description: "The annotation was kept without the screenshot." });
  }
  const file = annotationScreenshotFile(annotation);
  if (file) {
    try { await (deps.attach ?? addAttachment)(file); } catch { /* the annotation still goes */ }
  }
  if (picked.submission === "send") sendAnnotationDirectly(annotation);
  else addAnnotationToChat(annotation);
}

const PREVIEW_LABEL_MAX_CHARS = 80;
const truncate = (value: string, limit: number) => (value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`);
const normalizeText = (value: string) => value.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");

/** previewAnnotationContextLabel: the comment (one line, at most 80), else the page title, else "Preview annotation". */
export function previewAnnotationContextLabel(annotation: Pick<PreviewAnnotationPayload, "comment" | "pageTitle">): string {
  const comment = annotation.comment.trim().replace(/\s+/g, " ");
  if (comment) return comment.length <= PREVIEW_LABEL_MAX_CHARS ? comment : `${comment.slice(0, PREVIEW_LABEL_MAX_CHARS - 1)}…`;
  return annotation.pageTitle?.trim() || "Preview annotation";
}

function targetSummary(a: PreviewAnnotationPayload): string {
  const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (a.elements.length > 0) parts.push(plural(a.elements.length, "selected element"));
  if (a.regions.length > 0) parts.push(plural(a.regions.length, "marked region"));
  if (a.strokes.length > 0) parts.push(plural(a.strokes.length, "drawing"));
  return parts.join(", ");
}

/** previewAnnotationContextRecord (lib/composerContextRecords.ts). */
export function previewAnnotationContextRecord(a: PreviewAnnotationPayload): PreviewAnnotationContextRecord {
  const targets = a.elements.flatMap((target) => {
    const raw = target.element;
    const pageUrl = raw.pageUrl.trim(); const tagName = raw.tagName.trim().toLowerCase();
    if (!pageUrl || !tagName) return [];
    const frame = raw.source ?? null;
    return [{ id: target.id, element: {
      pageUrl, pageTitle: raw.pageTitle?.trim() ?? null, tagName, selector: raw.selector?.trim() || null,
      htmlPreview: truncate(normalizeText(raw.htmlPreview), 4000), componentName: raw.componentName?.trim() || null,
      source: frame ? { functionName: frame.functionName?.trim() || null, fileName: frame.fileName?.trim() || null, lineNumber: frame.lineNumber ?? null, columnNumber: frame.columnNumber ?? null } : null,
      styles: truncate(normalizeText(raw.styles), 4000),
    } }];
  });
  return {
    version: 1, contextId: toComposerContextId(`preview-annotation_${a.id}`), kind: "preview-annotation",
    label: sanitizeContextLabel(previewAnnotationContextLabel(a), "preview-annotation"),
    annotationId: a.id, pageUrl: a.pageUrl, pageTitle: a.pageTitle, comment: a.comment.trim(), targetSummary: targetSummary(a),
    styleChanges: a.styleChanges.map((c) => `${c.property}: ${c.previousValue || "(unset)"} → ${c.value}`),
    ...(targets.length > 0 ? { elements: targets.map((t) => t.element), elementIds: targets.map((t) => t.id) } : {}),
    styleChangeDetails: a.styleChanges.map((c) => ({ ...c })),
    ...(a.regions.length > 0 ? { regionCount: a.regions.length } : {}),
    ...(a.strokes.length > 0 ? { strokeCount: a.strokes.length } : {}),
  };
}

/** addPreviewAnnotation: the annotation joins the open thread's composer context, its token at the end of the prompt. */
export function addAnnotationToChat(annotation: PreviewAnnotationPayload): boolean {
  const thread = openThread();
  if (!thread) return false;
  const record = previewAnnotationContextRecord(annotation);
  attachExtraContext(thread.id, record);
  placeContextReference(extraContextMarker(record));
  return true;
}

/**
 * useComposerSend directAnnotation: Cmd/Ctrl+Enter in the annotation editor attaches the annotation and sends the draft at once.
 * When sending is not possible right now (offline, a run in progress, uploads or a question waiting) the annotation stays in the
 * draft and the user is told so.
 */
export function sendAnnotationDirectly(annotation: PreviewAnnotationPayload): void {
  if (!addAnnotationToChat(annotation)) return;
  const thread = openThread();
  const ready = thread !== null && thread !== undefined && Boolean(thread.projectId) && backendStatus() === "connected" && !isSending()
    && thread.status !== "running" && thread.status !== "awaiting" && threadUserInputs().length === 0 && draftAttachments().every((item) => item.status === "uploaded");
  if (!ready) {
    showToast({ type: "info", title: "Annotation attached to draft", description: "Sending is unavailable right now. Finish the current action, then send." });
    return;
  }
  sendDraft();
}
