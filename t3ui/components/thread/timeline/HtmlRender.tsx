// chat/HtmlRenderFrame.tsx + HtmlRenderDialog.tsx + shared/htmlRender.ts + shared/toolOutput.ts htmlRenderFromToolItem:
// a completed `html_render` tool call shows the published page inline in the timeline, with "Open full screen" on hover,
// and the expanded dialog (Close, Zoom out / Reset zoom / Zoom in, 50-200%, the title).
//
// The page is a native WebView. On a host that draws WebViews UNDER the GPUI surface (webview.underSurface, see
// rightPanel/nativeOcclusion.ts), the header and composer paint over the frame as it scrolls, so it is drawn inline.
// On the stock host a WebView draws above every GPUI element and cannot be clipped to the list viewport, so the row
// shows a card with the title and the same "Open full screen" action instead (the dialog is the top surface there).
import { colorScheme, effect, signal, Text, token, untracked, View, WebView } from "nsh";
import type { WebViewRef } from "nsh";
import { Dialog } from "nsh/base";
import { TimelineIcon } from "../markdown/TimelineIcon";
import { createHover } from "../../hoverReveal";
import { useOverlayOpen, webViewsUnderSurface } from "../../rightPanel/nativeOcclusion";
import { keepPressInDialog } from "../../dialogSurface";
import { EscapeCancel } from "../../EscapeCancel";
import { DIALOG_MS } from "../../motion/motionTokens";
import { errorToast } from "../../toast/toastState";
import { assetUrlFor } from "../../sidebar/projectIcon";
import { backendUrl, requestBackend } from "../../../store";
import { HTML_RENDER_COLUMN_WIDTH, htmlRenderFileName, htmlRenderFrameHeight, type HtmlRenderReference } from "./htmlRenderReference";
import { HTML_RENDER_WHEEL_SCRIPT, readTimelineWheel } from "./htmlRenderWheel";

const MIN_URL_LIFE_MS = 5 * 60_000;
/** The theme fragment the page's bootstrap reads (htmlRenderThemeFragment): the app's tokens as CSS variables. */
const THEME_VARIABLES: Record<string, string> = {
  "--background": "background", "--foreground": "foreground", "--muted": "muted", "--muted-foreground": "muted-foreground",
  "--card": "card", "--card-foreground": "card-foreground", "--popover": "popover", "--popover-foreground": "popover-foreground",
  "--secondary": "secondary", "--secondary-foreground": "secondary-foreground", "--border": "border", "--input": "input", "--ring": "ring",
  "--primary": "primary", "--primary-foreground": "primary-foreground", "--accent": "primary", "--accent-foreground": "primary-foreground",
  "--destructive": "destructive", "--destructive-foreground": "destructive-foreground", "--warning": "warning", "--warning-foreground": "warning-foreground",
};
export function htmlRenderThemeFragment(appearance: "light" | "dark", read: (name: string) => string | undefined): string {
  const variables: Record<string, string> = {};
  for (const [variable, name] of Object.entries(THEME_VARIABLES)) {
    const value = read(name);
    if (value) variables[variable] = value;
  }
  // FIXED_COLORS: success / info and charts 2-6 are fixed per appearance; --chart-1 is the accent.
  const fixed = appearance === "light"
    ? { success: "#10b981", successForeground: "#047857", info: "#3b82f6", infoForeground: "#1d4ed8", chart: ["#0d9488", "#d97706", "#9333ea", "#e11d48", "#65a30d"] }
    : { success: "#10b981", successForeground: "#34d399", info: "#3b82f6", infoForeground: "#60a5fa", chart: ["#2dd4bf", "#fbbf24", "#c084fc", "#fb7185", "#a3e635"] };
  variables["--success"] = fixed.success;
  variables["--success-foreground"] = fixed.successForeground;
  variables["--info"] = fixed.info;
  variables["--info-foreground"] = fixed.infoForeground;
  for (const name of ["accent", "destructive", "warning"]) {
    const surface = read(`${name}-surface`);
    if (surface) variables[`--${name}-surface`] = surface;
    const surfaceForeground = read(`${name}-surface-foreground`);
    if (surfaceForeground) variables[`--${name}-surface-foreground`] = surfaceForeground;
  }
  variables["--code-background"] = read("code-background") ?? read("muted") ?? variables["--muted"] ?? "";
  variables["--code-foreground"] = read("code-foreground") ?? variables["--foreground"] ?? "";
  if (variables["--accent"]) variables["--chart-1"] = variables["--accent"];
  fixed.chart.forEach((color, index) => { variables[`--chart-${index + 2}`] = color; });
  variables["--radius"] = "0.625rem";
  variables["--font-sans"] = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  variables["--font-mono"] = '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';
  return `#t3-theme=${encodeURIComponent(JSON.stringify({ appearance, variables }))}`;
}

function readToken(name: string): string | undefined {
  try { return token(name as never) as unknown as string; } catch { return undefined; }
}

/** The page reports its height (the reference's size-changed message, which a top-level page does not send). */
const MEASURE_SCRIPT = `(function(){var h;function z(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;try{window.nsh.postMessage(JSON.stringify({height:v}));}catch(e){}}if(window.ResizeObserver){var o=new ResizeObserver(z);o.observe(document.documentElement);if(document.body)o.observe(document.body);}z();window.addEventListener("load",z);})();true;`;

export function readContentHeight(data: string): number | undefined {
  try {
    const value = JSON.parse(data) as { height?: unknown };
    return typeof value.height === "number" && Number.isFinite(value.height) && value.height > 0 ? value.height : undefined;
  } catch { return undefined; }
}

type Request = (method: string, payload: unknown) => Promise<unknown>;

/** useLongLivedAssetUrl for the page: an inline text/html attachment URL and when it expires. */
export async function mintHtmlRenderUrl(reference: HtmlRenderReference, request: Request = requestBackend, endpoint: string = backendUrl()): Promise<{ src: string; expiresAt: number }> {
  const response = await request("assets.createUrl", {
    resource: { _tag: "attachment", attachmentId: reference.attachmentId, fileName: htmlRenderFileName(reference.title), mimeType: "text/html", disposition: "inline" },
  }) as { relativeUrl?: unknown; expiresAt?: unknown } | null;
  const src = assetUrlFor(endpoint, response?.relativeUrl);
  if (src === null) throw new Error("The environment returned an invalid asset URL.");
  return { src, expiresAt: typeof response?.expiresAt === "number" ? response.expiresAt : 0 };
}

function HtmlRenderDocument(props: { src: string; title: string; onContentHeight?: (height: number) => void; onTimelineWheel?: (delta: number) => void; zoom?: () => number }) {
  let ref: WebViewRef | null = null;
  const fragment = htmlRenderThemeFragment(colorSchemeNow(), readToken);
  const src = `${props.src.split("#", 1)[0]}${fragment}`;
  effect(() => {
    const zoom = props.zoom?.() ?? 1;
    ref?.injectJavaScript(`document.documentElement.style.zoom=${JSON.stringify(String(zoom))};true;`);
  });
  return (
    <WebView
      ref={(node) => { ref = node; }}
      src={src}
      class="size-full bg-background"
      accessibilityLabel={props.title}
      injectedJavaScript={props.onTimelineWheel ? `${MEASURE_SCRIPT}${HTML_RENDER_WHEEL_SCRIPT}` : MEASURE_SCRIPT}
      onMessage={(event) => { const height = readContentHeight(event.data); if (height !== undefined) props.onContentHeight?.(height); const delta = readTimelineWheel(event.data); if (delta !== undefined) props.onTimelineWheel?.(delta); }}
    />
  );
}

function colorSchemeNow(): "light" | "dark" {
  return colorScheme() === "dark" ? "dark" : "light";
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;

export function HtmlRenderDialog(props: { src: () => string | null; title: string; onClose: () => void }) {
  const open = () => props.src() !== null;
  useOverlayOpen(open, "html render", DIALOG_MS);
  const zoom = signal(1);
  effect(() => { if (open()) zoom.set(1); });
  const overlay = "h-8 items-center justify-center rounded-md px-2 hover:bg-accent-50";
  return (
    <Dialog
      open={open()}
      animation="fade"
      onOpenChange={({ open: next }) => { if (!next) props.onClose(); }}
      backdropStyle={{ backgroundColor: "rgba(0,0,0,0.8)" }}
      style={{ margin: "auto", width: "92%", height: "92%" }}
    >
      {open() ? <EscapeCancel onCancel={props.onClose} /> : null}
      {open() ? (
        <View class="size-full" onPress={keepPressInDialog} accessibilityLabel={`Expanded ${props.title} preview`}>
          <View class="h-10 flex-row items-center justify-end">
            <View class="size-7 items-center justify-center rounded-full hover:bg-accent-50" role="button" accessibilityLabel="Close" onPress={props.onClose}>
              <TimelineIcon name="x" size={14} tint="#ffffff" />
            </View>
          </View>
          <View class="min-h-0 flex-1 overflow-hidden rounded-lg border border-border-70 bg-background p-4">
            <HtmlRenderDocument src={props.src()!} title={props.title} zoom={zoom} />
          </View>
          <View class="mt-2 min-w-0 flex-row items-center justify-center gap-3">
            <Text class="min-w-0 truncate text-xs text-white">{props.title}</Text>
            <View class="shrink-0 flex-row items-center gap-1">
              <View class={`${overlay} ${zoom() === ZOOM_MIN ? "opacity-50" : ""}`} role="button" accessibilityLabel="Zoom out" disabled={zoom() === ZOOM_MIN} onPress={() => zoom.update((value) => Math.max(ZOOM_MIN, value - 0.25))}>
                <TimelineIcon name="minus" size={14} tint="#ffffff" />
              </View>
              <View class={overlay} role="button" accessibilityLabel="Reset zoom" onPress={() => zoom.set(1)}>
                <Text class="text-xs tabular-nums text-white">{`${Math.round(zoom() * 100)}%`}</Text>
              </View>
              <View class={`${overlay} ${zoom() === ZOOM_MAX ? "opacity-50" : ""}`} role="button" accessibilityLabel="Zoom in" disabled={zoom() === ZOOM_MAX} onPress={() => zoom.update((value) => Math.min(ZOOM_MAX, value + 0.25))}>
                <TimelineIcon name="plus" size={14} tint="#ffffff" />
              </View>
            </View>
          </View>
        </View>
      ) : null}
    </Dialog>
  );
}

/** What a frame measured and minted, per attachment, so a re-created row keeps its height and page. */
const frameMemory = new Map<string, { width?: number; contentHeight?: number | undefined; loaded?: { src: string; expiresAt: number } }>();
export function resetHtmlRenderMemoryForTests() { frameMemory.clear(); }

export function HtmlRenderFrame(props: {
  reference: () => HtmlRenderReference;
  onTimelineWheel?: (delta: number) => void;
  /** Test seams. */
  request?: Request;
  endpoint?: string;
  inline?: () => boolean;
}) {
  // The list re-creates a row when the turns around it re-fold (a new turn starting), so the measured page height and
  // the minted URL outlive the component, keyed by attachment: a re-created frame comes back at the same height and
  // page instead of starting at the agent's height and growing (which pulled the list off the end).
  const firstId = untracked(() => props.reference().attachmentId);
  const remembered = frameMemory.get(firstId);
  const width = signal(remembered?.width ?? HTML_RENDER_COLUMN_WIDTH);
  const contentHeight = signal<number | undefined>(remembered?.contentHeight);
  const height = () => htmlRenderFrameHeight(props.reference(), width(), contentHeight());
  const loaded = signal<{ src: string; expiresAt: number } | null>(remembered?.loaded ?? null);
  const failed = signal(false);
  const expandedSrc = signal<string | null>(null);
  const hover = createHover();
  const inline = () => (props.inline ? props.inline() : webViewsUnderSurface());
  const mint = () => mintHtmlRenderUrl(props.reference(), props.request, props.endpoint);
  // The frame keeps the first URL it loads, so later mints do not reload the page.
  // Keyed by the attachment id only: the row's reference is a new object on every timeline rebuild (each streamed
  // event), and re-minting on those dropped and re-created the page's WebView, which made the list jump to it.
  const attachmentId = signal(firstId);
  effect(() => { const id = props.reference().attachmentId; if (id !== untracked(attachmentId)) attachmentId.set(id); });
  effect(() => { const id = attachmentId(); frameMemory.set(id, { ...frameMemory.get(id), width: width(), contentHeight: contentHeight() }); });
  effect(() => {
    const id = attachmentId();
    const kept = frameMemory.get(id)?.loaded;
    if (kept && kept.expiresAt - Date.now() > MIN_URL_LIFE_MS) { if (untracked(loaded) !== kept) loaded.set(kept); return; }
    loaded.set(null);
    failed.set(false);
    let stale = false;
    void untracked(mint).then((value) => { if (!stale) { loaded.set(value); frameMemory.set(id, { ...frameMemory.get(id), loaded: value }); } }, () => { if (!stale) failed.set(true); });
    return () => { stale = true; };
  });
  const openFullScreen = async () => {
    const current = loaded();
    const url = current !== null && current.expiresAt - Date.now() > MIN_URL_LIFE_MS ? current.src : await mint().then((value) => value.src, () => null);
    if (url !== null) expandedSrc.set(url);
    else errorToast("Page unavailable", "Reconnect to the environment and try again.");
  };
  const title = () => props.reference().title;
  const button = (
    <View class="absolute right-2 top-2 size-6 items-center justify-center rounded-md border border-border bg-popover" role="button" accessibilityLabel="Open full screen" tooltip="Open full screen" onPress={() => void openFullScreen()}>
      <TimelineIcon name="maximize-2" size={14} />
    </View>
  );
  return (
    <View class="min-w-0 px-1">
      {inline() ? (
        <View class="relative" style={{ height: height() }} onLayout={(event) => width.set(Math.max(1, Math.round(event.bounds.size.width)))} accessibilityLabel={`${title()} page`} {...hover.bind}>
          {loaded() !== null ? <HtmlRenderDocument src={loaded()!.src} title={title()} onContentHeight={(next) => contentHeight.set(next)} onTimelineWheel={props.onTimelineWheel} /> : null}
          {failed() ? (
            <View class="size-full items-center justify-center"><Text class="text-xs text-muted-foreground">{`Unable to load ${title()}`}</Text></View>
          ) : null}
          {loaded() !== null && hover.hovered() ? button : null}
        </View>
      ) : (
        // A host that draws WebViews above the app: a card for the page and its full-screen view.
        <View class="relative min-h-16 flex-row items-center gap-2 rounded-lg border border-border bg-card px-3 py-3" accessibilityLabel={`${title()} page`}>
          <TimelineIcon name="file" size={14} />
          <Text class="min-w-0 flex-1 truncate text-sm text-foreground">{failed() ? `Unable to load ${title()}` : title()}</Text>
          {loaded() !== null ? (
            <View class="size-6 items-center justify-center rounded-md hover:bg-accent" role="button" accessibilityLabel="Open full screen" tooltip="Open full screen" onPress={() => void openFullScreen()}>
              <TimelineIcon name="maximize-2" size={14} />
            </View>
          ) : null}
        </View>
      )}
      <HtmlRenderDialog src={expandedSrc} title={title()} onClose={() => expandedSrc.set(null)} />
    </View>
  );
}

