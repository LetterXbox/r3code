// ExpandedImageDialog.tsx: a markdown image or video shown large over the app, with Previous / Next through the message's media,
// the name and "(i/n)" under it, a close button, Escape and the arrow keys. ZoomableImage.tsx: the wheel zooms around the pointer
// (Ctrl faster; `onWheel` needs host patch 0012, a host without it scrolls nothing), a click toggles fit and 2x at the pointer,
// a drag pans a zoomed image, and the keys zoom and pan. The Zoom in / Zoom out / Reset buttons are the port's own (kept).
//
// A real nsh Dialog (a native popup layer above every page), registered with the WebView occlusion registry while it is up.
import { announce, cleanup, effect, Image, keymap, signal, Text, untracked, Video, View, windowSize } from "nsh";
import { changeZoom, clampPan, clickZoom, DRAG_CLICK_SLOP, wheelZoom, zoomViewport } from "./zoomableImage";
import type { ZoomView } from "./zoomableImage";
import { showMediaMenu } from "./MarkdownMedia";
import { currentWorkspace } from "../../rightPanel/panelState";
import { Dialog } from "nsh/base";
import { useOverlayOpen } from "../../rightPanel/nativeOcclusion";
import { keepPressInDialog } from "../../dialogSurface";
import { EscapeCancel } from "../../EscapeCancel";
import { DIALOG_MS } from "../../motion/motionTokens";
import { TimelineIcon } from "./TimelineIcon";
import { overlayThreadKey, registerThreadOverlay } from "../threadOverlayRetention";
import { MEDIA_IMAGE_BYTES, MEDIA_PLAYER_BYTES, readMediaFile } from "./markdownAsset";
import type { ExpandedMediaItem, ExpandedMediaPreview, MediaKind, MediaSource } from "./mediaSources";
export type { ExpandedMediaItem, ExpandedMediaPreview, MediaSource } from "./mediaSources";

const preview = signal<ExpandedMediaPreview | null>(null);
// The thread the preview was opened for (ExpandedImageDialog.tsx expandedImagePreviewAtom threadKey).
let previewThreadKey: string | null = null;
export const expandedMediaPreview = () => preview();
export function expandMedia(next: ExpandedMediaPreview): void {
  if (next.items.length === 0) return;
  previewThreadKey = overlayThreadKey();
  preview.set({ items: next.items, index: Math.min(Math.max(next.index, 0), next.items.length - 1) });
}
export function closeExpandedMedia(): void { preview.set(null); }
registerThreadOverlay((threadKey) => {
  if (untracked(preview) !== null && previewThreadKey !== threadKey) closeExpandedMedia();
});
/** The index after stepping `direction` through `count` items, wrapping at the ends. */
export const stepMediaIndex = (index: number, count: number, direction: -1 | 1): number => (count <= 0 ? 0 : (((index + direction) % count) + count) % count);

// ---- bytes to a URL ----

export type MediaUrlState = { kind: "loading" } | { kind: "ready"; url: string } | { kind: "failed" };
const urlCache = new Map<string, string>();
const CACHE_LIMIT = 48;

function remember(key: string, url: string) {
  urlCache.set(key, url);
  if (urlCache.size > CACHE_LIMIT) {
    const oldest = urlCache.keys().next().value;
    if (oldest !== undefined) {
      const stale = urlCache.get(oldest);
      urlCache.delete(oldest);
      if (stale) URL.revokeObjectURL(stale);
    }
  }
}

const mimeForPath = (path: string): string => {
  const extension = (path.split(".").at(-1) ?? "").toLowerCase();
  const known: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg" };
  return known[extension] ?? "application/octet-stream";
};

/** The URL a source shows from: a url source at once, a file through the asset route (cached, released with the cache). */
export function mediaUrlState(source: () => MediaSource | null, kind: () => MediaKind): { state: () => MediaUrlState; retry: () => void } {
  const state = signal<MediaUrlState>({ kind: "loading" });
  const attempt = signal(0);
  effect(() => {
    const current = source();
    attempt();
    if (current === null) { state.set({ kind: "failed" }); return; }
    if (current.kind === "url") { state.set({ kind: "ready", url: current.url }); return; }
    const key = `${current.threadId}\u0000${current.path}`;
    const hit = urlCache.get(key);
    if (hit) { state.set({ kind: "ready", url: hit }); return; }
    state.set({ kind: "loading" });
    const controller = new AbortController();
    let active = true;
    void readMediaFile(current.threadId, current.path, { signal: controller.signal, maxBytes: kind() === "image" ? MEDIA_IMAGE_BYTES : MEDIA_PLAYER_BYTES }).then((blob) => {
      if (!active) return;
      const url = URL.createObjectURL(new Blob([blob], { type: mimeForPath(current.path) }));
      remember(key, url);
      state.set({ kind: "ready", url });
    }).catch(() => { if (active && !controller.signal.aborted) state.set({ kind: "failed" }); });
    return () => { active = false; controller.abort(); };
  });
  return { state, retry: () => attempt.update((count) => count + 1) };
}

// ---- the dialog ----

const HOVER = { backgroundColor: "rgba(255,255,255,0.1)" };
const BUTTON = { backgroundColor: "rgba(0,0,0,0.6)" };
const BUTTON_HOVER = { backgroundColor: "rgba(0,0,0,0.8)" };
const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6, 8];

const FAILED_TEXT = "Image unavailable. The file may have been moved or deleted.";

function ExpandedBody(props: { item: () => ExpandedMediaItem; box: () => { width: number; height: number } }) {
  const media = mediaUrlState(() => props.item().source, () => props.item().kind);
  const failed = signal(false);
  const natural = signal<{ width: number; height: number } | null>(null);
  const view = signal<ZoomView>({ zoom: 1, left: 0, top: 0 });
  effect(() => { props.item(); failed.set(false); natural.set(null); view.set({ zoom: 1, left: 0, top: 0 }); });
  const zoom = () => view().zoom;
  // ZoomableImage: a resized viewer refits the image (the zoom goes back to fit).
  { let last: string | null = null; effect(() => { const size = windowSize(); const key = `${size.width}x${size.height}`; if (last !== null && key !== last) untracked(() => view.set({ zoom: 1, left: 0, top: 0 })); last = key; }); }
  const fitted = () => {
    const size = natural();
    const box = props.box();
    if (!size) return { width: box.width, height: box.height };
    const scale = Math.min(box.width / size.width, box.height / size.height, 1);
    return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
  };
  const zoomBox = () => ({ ...fitted(), maxWidth: props.box().width, maxHeight: props.box().height });
  const zoomTo = (next: number, point?: { x: number; y: number }) => view.set(changeZoom(zoomBox(), view(), next, point));
  // The buttons step through these levels from wherever the wheel left the zoom.
  const stepUp = () => ZOOM_STEPS.find((level) => level > zoom() + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  const stepDown = () => [...ZOOM_STEPS].reverse().find((level) => level < zoom() - 0.001) ?? 1;
  // ZoomableImage pan(): arrow keys pan 40 points while zoomed (otherwise they step the gallery); newer bindings win over the
  // host's. Left / Right step the gallery when the image does not scroll sideways.
  const PAN_STEP = 40;
  effect(() => {
    if (zoom() <= 1) return;
    const pan = (dx: number, dy: number) => () => { const before = view(); view.set(clampPan(zoomBox(), { zoom: before.zoom, left: before.left + dx, top: before.top + dy })); };
    const sideways = fitted().width * zoom() > zoomViewport(zoomBox(), zoom()).width + 0.5;
    return keymap.bind({ ...(sideways ? { left: pan(-PAN_STEP, 0), right: pan(PAN_STEP, 0) } : {}), up: pan(0, -PAN_STEP), down: pan(0, PAN_STEP) }, { when: "always", repeat: true });
  });
  // ZoomableImage's "<n>% zoom" live region: a zoom change is spoken.
  { let first = true; let last = 1; effect(() => { const level = Math.round(zoom() * 100); if (first) { first = false; last = level; return; } if (level !== last) { last = level; announce(`${level}% zoom`); } }); }
  // ZoomableImage keys: Enter / Space toggle 1x and 2x, + / = zoom by 1.5, - by 1 / 1.5, 0 fits (images only).
  effect(() => {
    if (props.item().kind === "video") return;
    return keymap.bind({
      enter: () => zoomTo(clickZoom(zoom())),
      space: () => zoomTo(clickZoom(zoom())),
      plus: () => zoomTo(zoom() * 1.5),
      minus: () => zoomTo(zoom() / 1.5),
      "0": () => zoomTo(1),
    }, { when: "always" });
  });
  // ZoomableImage pointer: a drag of a zoomed image pans it; the click that ends a drag does not zoom.
  let drag: { x: number; y: number; left: number; top: number } | null = null;
  let suppressClick = false;
  const dragging = signal(false);
  const url = () => { const current = media.state(); return current.kind === "ready" ? current.url : ""; };
  const unavailable = () => failed() || media.state().kind === "failed";
  const label = () => (props.item().kind === "video" ? "Video unavailable. The file may have been moved or deleted." : FAILED_TEXT);
  return (
    <View class="items-center gap-2">
      {unavailable() ? (
        <View class="h-48 w-[512px] max-w-full items-center justify-center gap-3 rounded-lg border border-border-70 p-6" style={{ backgroundColor: "#000" }} role="alert">
          <Text class="text-center text-sm text-white">{label()}</Text>
          <View class="rounded-md border border-border-70 px-3 py-1.5" role="button" accessibilityLabel="Retry" onPress={() => { failed.set(false); media.retry(); }}><Text class="text-xs text-white">Retry</Text></View>
        </View>
      ) : media.state().kind === "loading" ? (
        <View class="h-48 w-[512px] max-w-full items-center justify-center rounded-lg" style={{ backgroundColor: "#000" }} accessibilityLabel="Loading media"><Text class="text-sm text-white">Loading...</Text></View>
      ) : props.item().kind === "video" ? (
        <Video src={url()} controls style={{ width: props.box().width, height: props.box().height }} class="rounded-lg border border-border-70" onError={() => failed.set(true)} accessibilityLabel={props.item().name} />
      ) : (
        <View class="items-center justify-center" style={{ width: props.box().width, height: props.box().height }} onContextMenu={((event: { pagePosition: { x: number; y: number } }) => showMediaMenu(props.item().source, currentWorkspace()?.cwd ?? null, event.pagePosition, { kind: "image", name: props.item().name })) as never}>
          <View
            class="overflow-hidden rounded-lg bg-background"
            style={{ ...zoomViewport(zoomBox(), zoom()), cursor: zoom() > 1 ? (dragging() ? "grabbing" : "grab") : "zoom-in" }}
            role="image"
            accessibilityLabel={`${props.item().name}, zoomable image`}
            accessibilityHint="Click to zoom in or return to fit. Scroll to zoom, drag to pan. Use Enter to toggle zoom, plus or minus to zoom, and 0 to fit."
            testID="zoomable-image"
            {...({ onWheel: (event: { position: { x: number; y: number }; deltaY: number; modifiers: { control: boolean } }) => { if (event.deltaY !== 0) zoomTo(wheelZoom(zoom(), event.deltaY, event.modifiers.control), event.position); } } as object)}
            onPressDown={(event) => { suppressClick = false; if (zoom() <= 1) return; const current = view(); drag = { x: event.pagePosition.x, y: event.pagePosition.y, left: current.left, top: current.top }; dragging.set(true); }}
            onMouseMove={(event) => {
              if (!drag) return;
              if (event.pressedButton !== "left") { drag = null; dragging.set(false); return; }
              const dx = event.pagePosition.x - drag.x;
              const dy = event.pagePosition.y - drag.y;
              if (Math.hypot(dx, dy) > DRAG_CLICK_SLOP) suppressClick = true;
              view.set(clampPan(zoomBox(), { zoom: zoom(), left: drag.left - dx, top: drag.top - dy }));
            }}
            onPressUp={() => { drag = null; dragging.set(false); }}
            onPress={(event) => { if (suppressClick || event.clickCount > 1) return; zoomTo(clickZoom(zoom()), event.position); }}
          >
            <Image
              src={url()}
              accessibilityLabel={props.item().name}
              onLoad={(event) => natural.set({ width: event.size.width, height: event.size.height })}
              onError={() => failed.set(true)}
              style={{ position: "absolute", left: -view().left, top: -view().top, width: Math.round(fitted().width * zoom()), height: Math.round(fitted().height * zoom()), objectFit: "contain" }}
            />
          </View>
        </View>
      )}
      {props.item().kind === "image" && !unavailable() ? (
        <View class="flex-row items-center gap-1" role="toolbar" accessibilityLabel="Zoom">
          <View class="size-7 items-center justify-center rounded-md " hoverStyle={HOVER} role="button" accessibilityLabel="Zoom out" disabled={zoom() <= 1} onPress={() => zoomTo(stepDown())}><TimelineIcon name="zoom-out" size={14} tint="#ffffff" /></View>
          <View class="h-7 items-center justify-center rounded-md px-1.5 " hoverStyle={HOVER} role="button" accessibilityLabel="Reset zoom" disabled={zoom() <= 1} onPress={() => zoomTo(1)}><Text class="text-xs tabular-nums text-white">{`${Math.round(zoom() * 100)}%`}</Text></View>
          <View class="size-7 items-center justify-center rounded-md " hoverStyle={HOVER} role="button" accessibilityLabel="Zoom in" disabled={zoom() >= ZOOM_STEPS[ZOOM_STEPS.length - 1]} onPress={() => zoomTo(stepUp())}><TimelineIcon name="zoom-in" size={14} tint="#ffffff" /></View>
        </View>
      ) : null}
    </View>
  );
}

/** Mount once (App.tsx): draws the open preview, if any. */
export function ExpandedMediaHost() {
  const open = () => preview() !== null;
  useOverlayOpen(open, "expanded media", DIALOG_MS);
  const index = () => preview()?.index ?? 0;
  const count = () => preview()?.items.length ?? 0;
  const item = () => preview()?.items[index()] ?? null;
  const step = (direction: -1 | 1) => preview.update((current) => (current && current.items.length > 1 ? { ...current, index: stepMediaIndex(current.index, current.items.length, direction) } : current));
  effect(() => {
    if (!open()) return;
    return keymap.bind({ escape: closeExpandedMedia, left: () => step(-1), right: () => step(1) }, { when: "always" });
  });
  cleanup(() => closeExpandedMedia());
  const noun = () => (item()?.kind === "video" ? "video" : "image");
  return (
    <Dialog
      open={open()}
      animation="fade"
      testID="expanded-media"
      onOpenChange={({ open: next }) => { if (!next) closeExpandedMedia(); }}
      backdropStyle={{ backgroundColor: "rgba(0,0,0,0.8)" }}
      style={{ margin: "auto", width: "92%", height: "92%" }}
    >
      {open() ? <EscapeCancel onCancel={closeExpandedMedia} /> : null}
      <View class="size-full items-center justify-center" onPress={closeExpandedMedia} accessibilityLabel={`Expanded ${noun()} preview`}>
        {item() ? (
          <View class="max-h-full max-w-full items-center gap-2" onPress={keepPressInDialog}>
            <ExpandedBody item={() => item()!} box={() => ({ width: 960, height: 600 })} />
            <Text class="max-w-[640px] truncate text-xs text-white" accessibilityLabel={`${item()!.name}${count() > 1 ? ` (${index() + 1}/${count()})` : ""}`}>
              {`${item()!.name}${count() > 1 ? ` (${index() + 1}/${count()})` : ""}`}
            </Text>
          </View>
        ) : null}
        <View class="absolute right-0 top-0 size-9 items-center justify-center rounded-full " style={BUTTON} hoverStyle={BUTTON_HOVER} role="button" accessibilityLabel={`Close ${noun()} preview`} onPress={closeExpandedMedia}>
          <TimelineIcon name="x" size={16} tint="#ffffff" />
        </View>
        {count() > 1 ? (
          <>
            <View class="absolute left-0 top-1/2 size-10 items-center justify-center rounded-full " style={BUTTON} hoverStyle={BUTTON_HOVER} role="button" accessibilityLabel="Previous media" onPress={() => step(-1)}><TimelineIcon name="chevron-left" size={20} tint="#ffffff" /></View>
            <View class="absolute right-0 top-1/2 size-10 items-center justify-center rounded-full " style={BUTTON} hoverStyle={BUTTON_HOVER} role="button" accessibilityLabel="Next media" onPress={() => step(1)}><TimelineIcon name="chevron-right" size={20} tint="#ffffff" /></View>
          </>
        ) : null}
      </View>
    </Dialog>
  );
}
