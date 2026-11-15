// shared/htmlRender.ts + shared/toolOutput.ts htmlRenderFromToolItem: the page reference a completed `html_render`
// tool call carries, and the frame height rules. Pure (no store), so workLog.ts can use it.
import { t3McpToolId } from "./t3McpTools";

export const HTML_RENDER_TOOL_NAME = "html_render";
export const HTML_RENDER_MIN_HEIGHT = 80;
export const HTML_RENDER_MAX_HEIGHT = 2000;
export const HTML_RENDER_MAX_FIT_HEIGHT = 20_000;
export const HTML_RENDER_MAX_TITLE_LENGTH = 200;
export const HTML_RENDER_COLUMN_WIDTH = 728;
const MAX_MEASURED_HEIGHTS = 24;
const MAX_CONTENT_BLOCKS = 32;
const MAX_ENVELOPE_DEPTH = 4;

export interface HtmlRenderReference {
  attachmentId: string;
  title: string;
  height: number;
  heights?: (readonly [number, number])[];
}

export function clampHtmlRenderHeight(height: number): number {
  return Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)));
}

function readMeasuredHeights(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MEASURED_HEIGHTS) return undefined;
  const heights = value.flatMap((entry) =>
    Array.isArray(entry) && entry.length === 2 && Number.isInteger(entry[0]) && entry[0] >= 1 && entry[0] <= 10_000 && typeof entry[1] === "number" && Number.isFinite(entry[1])
      ? [[entry[0] as number, clampHtmlRenderHeight(entry[1])] as const]
      : [],
  );
  return heights.length === value.length ? [...heights].sort((left, right) => left[0] - right[0]) : undefined;
}

export function readHtmlRenderReference(value: unknown): HtmlRenderReference | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { attachmentId, title, height, heights } = value as Record<string, unknown>;
  if (typeof attachmentId !== "string" || attachmentId.length === 0 || attachmentId.length > 256 || typeof title !== "string" || typeof height !== "number" || !Number.isFinite(height)) return undefined;
  const measured = readMeasuredHeights(heights);
  return { attachmentId, title: title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || "HTML", height: clampHtmlRenderHeight(height), ...(measured === undefined ? {} : { heights: measured }) };
}

function measuredHeight(heights: NonNullable<HtmlRenderReference["heights"]>, width: number) {
  const above = heights.findIndex(([measuredWidth]) => measuredWidth >= width);
  const high = above === -1 ? heights.length - 1 : above;
  const low = heights[high]![0] === width ? high : Math.max(0, high - 1);
  return Math.max(heights[low]![1], heights[high]![1]);
}

/** htmlRenderFrameHeight: the live page's height when measured, else the server's per-width measurement, else the agent's. */
export function htmlRenderFrameHeight(reference: HtmlRenderReference, width: number, contentHeight?: number): number {
  if (contentHeight !== undefined) return Math.min(HTML_RENDER_MAX_FIT_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.ceil(contentHeight)));
  const heights = reference.heights;
  if (heights === undefined || heights.length === 0) return clampHtmlRenderHeight(reference.height);
  const cap = measuredHeight(heights, HTML_RENDER_COLUMN_WIDTH) > reference.height ? reference.height : HTML_RENDER_MAX_HEIGHT;
  return clampHtmlRenderHeight(Math.min(cap, measuredHeight(heights, width)));
}

export function htmlRenderFileName(title: string): string {
  const name = title.replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 120).trim();
  return `${name || "Page"}.html`;
}

/** toolOutput.ts readResult, reduced to what htmlRender needs: the envelope's data object and whether it failed. */
export function readResult(value: unknown, depth = 0): { data?: Record<string, unknown>; failed: boolean } {
  if (depth > MAX_ENVELOPE_DEPTH) return { failed: false };
  if (typeof value === "string") {
    try { return readResult(JSON.parse(value), depth + 1); } catch { return { failed: false }; }
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CONTENT_BLOCKS) return { failed: false };
    let data: Record<string, unknown> | undefined;
    let failed = false;
    for (const block of value) {
      const text = typeof block === "object" && block !== null ? (block as Record<string, unknown>).text : undefined;
      const inner = typeof text === "object" && text !== null ? ((text as Record<string, unknown>).text ?? text) : text;
      const result = readResult(inner, depth + 1);
      data ??= result.data;
      failed ||= result.failed;
    }
    return { ...(data === undefined ? {} : { data }), failed };
  }
  if (typeof value !== "object" || value === null) return { failed: false };
  const record = value as Record<string, unknown>;
  const failed = record.isError === true || record.is_error === true || record._tag === "OrchestratorMcpFailure" || record.error != null;
  const content = record.structuredContent ?? record.content;
  if (content !== undefined) {
    const nested = readResult(content, depth + 1);
    return { ...nested, failed: failed || nested.failed };
  }
  return { data: record, failed };
}

/** htmlRenderFromToolItem: a completed `html_render` call's page reference, unless the call failed. */
export function htmlRenderFromToolItem(item: { toolName?: unknown; output?: unknown; status?: unknown; type?: unknown }): HtmlRenderReference | undefined {
  if (item.type !== "dynamic_tool" || item.status !== "completed") return undefined;
  if (t3McpToolId(typeof item.toolName === "string" ? item.toolName : null) !== HTML_RENDER_TOOL_NAME) return undefined;
  const result = readResult(item.output);
  return result.failed ? undefined : readHtmlRenderReference(result.data?.htmlRender);
}

export function htmlRenderFromWorkItem(item: { item?: unknown }): HtmlRenderReference | undefined {
  return item.item ? htmlRenderFromToolItem(item.item as Record<string, unknown>) : undefined;
}

