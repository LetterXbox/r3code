// The anchored toast (ui/toast.tsx's AnchoredToastProvider and ui/anchoredCopyToast.ts): the small "Copied!" popup that appears
// under the control that was pressed, with a 1 s timeout, or the "Failed to copy" error with its reason. The host
// (AnchoredToastHost.tsx) draws them at the anchor's page rectangle.
import { signal } from "nsh";
import type { PageRect } from "../rightPanel/nativeOcclusion";

export const ANCHORED_COPY_TOAST_TIMEOUT_MS = 1000;
/** Base UI's positioner sideOffset for anchored toasts. */
export const ANCHORED_TOAST_SIDE_OFFSET = 4;

export interface AnchoredToastItem {
  id: string;
  rect: PageRect;
  title: string;
  description?: string;
  type?: "error";
  /** The compact tooltip look: one line in a rounded-md box with no dismiss button. */
  tooltipStyle: boolean;
}

export interface AnchoredToastInput {
  title: string;
  description?: string;
  type?: "error";
  tooltipStyle?: boolean;
  /** Milliseconds until it closes itself; 0 keeps it until dismissed. Default 5000, as the main stack. */
  timeoutMs?: number;
}

/** What an anchor can be: a measured page rectangle, or a view ref that can measure itself. */
export type ToastAnchor = PageRect | { measure(): Promise<{ bounds: { size: { width: number; height: number } }; pagePosition: { x: number; y: number } } | null> };

const items = signal<AnchoredToastItem[]>([]);
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let counter = 0;

export const anchoredToasts = () => items();

async function resolveRect(anchor: ToastAnchor): Promise<PageRect | null> {
  if ("measure" in anchor) {
    const measured = await anchor.measure().catch(() => null);
    return measured ? { x: measured.pagePosition.x, y: measured.pagePosition.y, width: measured.bounds.size.width, height: measured.bounds.size.height } : null;
  }
  return anchor;
}

export function closeAnchoredToast(id: string) {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
  items.update((all) => all.filter((item) => item.id !== id));
}

/** Raises a toast under `anchor`; resolves to its id, or null when the anchor could not be measured (nothing shows). */
export async function showAnchoredToast(anchor: ToastAnchor, input: AnchoredToastInput): Promise<string | null> {
  const rect = await resolveRect(anchor);
  if (!rect) return null;
  const id = `anchored:${++counter}`;
  items.update((all) => [...all, {
    id, rect, title: input.title, tooltipStyle: input.tooltipStyle === true,
    ...(input.description ? { description: input.description } : {}),
    ...(input.type ? { type: input.type } : {}),
  }]);
  const ms = input.timeoutMs ?? 5000;
  if (ms > 0) timers.set(id, setTimeout(() => closeAnchoredToast(id), ms));
  return id;
}

export function showAnchoredCopySuccessToast(anchor: ToastAnchor) {
  return showAnchoredToast(anchor, { title: "Copied!", tooltipStyle: true, timeoutMs: ANCHORED_COPY_TOAST_TIMEOUT_MS });
}

export function showAnchoredCopyErrorToast(anchor: ToastAnchor, error: Error) {
  return showAnchoredToast(anchor, { type: "error", title: "Failed to copy", description: error.message });
}

export function clearAnchoredToasts() {
  for (const id of [...timers.keys()]) closeAnchoredToast(id);
  items.set([]);
}
