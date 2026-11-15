// PreviewView.tsx adjustServerTab (client-runtime state/preview.ts adjust = preview.adjust): zoom, appearance, hard
// reload and clearing for a server-hosted browser tab. The answer is the tab's new snapshot (its zoomFactor included).
import { signal } from "nsh";
import { requestBackend } from "../../store";
import { showToast } from "../toast/toastState";

export interface PreviewAdjustment { colorScheme?: "light" | "dark" | "system"; zoomFactor?: number; hardReload?: boolean; clear?: "cookies" | "cache" }
type Request = (method: string, payload: unknown) => Promise<unknown>;

/** Each server tab's zoomFactor from its last preview.adjust answer (DEFAULT_PREVIEW_ZOOM_FACTOR 1 before any). */
export const serverTabZoom = signal<Readonly<Record<string, number>>>({});
export const serverTabZoomFor = (tabId: string) => serverTabZoom()[tabId] ?? 1;
/** Each server tab's colorScheme from its last preview.adjust answer ("system" before any). */
export const serverTabScheme = signal<Readonly<Record<string, "light" | "dark" | "system">>>({});
export const serverTabSchemeFor = (tabId: string) => serverTabScheme()[tabId] ?? "system";

export async function adjustServerPreview(threadId: string, tabId: string, change: PreviewAdjustment, request: Request = requestBackend): Promise<boolean> {
  try {
    const result = await request("preview.adjust", { threadId, tabId, ...change });
    const zoom = result && typeof result === "object" ? (result as { zoomFactor?: unknown }).zoomFactor : undefined;
    const next = typeof zoom === "number" ? zoom : change.zoomFactor;
    if (typeof next === "number") serverTabZoom.update((all) => ({ ...all, [tabId]: next }));
    const scheme = result && typeof result === "object" ? (result as { colorScheme?: unknown }).colorScheme : undefined;
    const nextScheme = scheme === "light" || scheme === "dark" || scheme === "system" ? scheme : change.colorScheme;
    if (nextScheme) serverTabScheme.update((all) => ({ ...all, [tabId]: nextScheme }));
    return true;
  } catch (error) {
    showToast({ type: "error", title: "Unable to change the browser tab", description: error instanceof Error ? error.message : "An error occurred." });
    return false;
  }
}
