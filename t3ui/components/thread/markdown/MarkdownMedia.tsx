// What ChatMarkdown draws for `![alt](src)` (ChatMarkdownMedia.tsx, ChatMarkdown.tsx `img`): an image, a video or an audio clip by
// its source's type, each from a URL or a workspace file, with the reference's loading, unavailable and expand states. Images and
// videos are the runtime's own Image and Video views, not WebViews, so nothing here draws above app content.
import { Clipboard, effect, Image, openUrl, signal, Text, Video, View } from "nsh";
import type { TextViewImage } from "nsh/base";
import { errorToast, showToast } from "../../toast";
import { updateToast } from "../../toast/toastState";
import { copyMediaImage, openMediaLink, saveMedia } from "./mediaContent";
import { currentWorkspace, openFileAction } from "../../rightPanel/panelState";
import { popupOverOverlay } from "../../files/filePopup";
import { FileChip } from "./MarkdownChips";
import { expandMedia, mediaUrlState } from "./ExpandedMedia";
import { TimelineIcon } from "./TimelineIcon";
import { resolveMarkdownFileLinkMeta, workspaceRelativeFilePath } from "./fileLinkMeta";
import { authoredImageSize, fitMedia, galleryIndexOf, markdownImageCopy, mediaFileName, mediaPreviewName, mediaUnavailableText, resolveMarkdownMedia, type ExpandedMediaItem, type MediaKind, type MediaSource } from "./mediaSources";
import type { CodexArtifactTemplate, CodexArtifactTemplateKind } from "./codexDirectives";
import { codexArtifactTemplatePresentationLabel } from "./codexDirectives";
import { formatClock } from "../mediaLayout";
import { tokenAlpha } from "../../composer/tokenColor";

/** `border-border/40` (no flattened token for 40): the border token at 40% as a style. */
const frameBorder = () => ({ borderColor: tokenAlpha("border", 0.4) });

export interface MediaContext {
  cwd: () => string | null;
  threadId: () => string | null;
  gallery: () => ExpandedMediaItem[];
}

/** The reference's `Image unavailable · alt` box: a muted bordered line with a warning mark. */
export function MediaFallback(props: { kind: MediaKind; alt: string; detail?: string }) {
  return (
    <View class="flex-row items-center gap-1.5 self-start rounded-md border bg-muted-40 px-2 py-1" style={frameBorder()} role="alert" accessibilityLabel={mediaUnavailableText(props.kind, props.alt, props.detail)}>
      <TimelineIcon name="triangle-alert" size={14} tint="#a3a3a3" />
      <Text class="text-xs text-muted-foreground">{mediaUnavailableText(props.kind, props.alt, props.detail)}</Text>
    </View>
  );
}

/** What a media's right press offers (MediaActions.tsx): Copy full path / Copy relative path / Copy URL, Open in file viewer. */
/** Save and Copy image, with MediaActions' progress and failure toasts. */
function mediaAction(label: string, progress: string, done: string, run: () => Promise<unknown>) {
  return () => {
    const id = showToast({ type: "loading", title: progress });
    void run().then(
      () => updateToast(id, { type: "success", title: done }),
      (cause: unknown) => updateToast(id, { type: "error", title: `Could not ${label.toLowerCase()}`, description: cause instanceof Error ? cause.message : "The media action failed." }),
    );
  };
}

export function mediaMenuItems(source: MediaSource | null, cwd: string | null, media?: { kind: "image" | "video"; name: string }): { label: string; onSelect: () => void; disabled?: boolean }[] {
  const items: { label: string; onSelect: () => void; disabled?: boolean }[] = [];
  const copy = (value: string, title: string) => () => { void Clipboard.writeText(value).then(() => showToast({ type: "success", title: `${title} copied`, description: value })).catch((cause: unknown) => errorToast(`Failed to copy ${title.toLowerCase()}`, cause instanceof Error ? cause.message : "An error occurred.")); };
  if (source?.kind === "file") {
    items.push({ label: "Copy full path", onSelect: copy(source.path, "Full path") });
    const relative = workspaceRelativeFilePath(source.path, cwd);
    if (relative !== null && relative !== ".") {
      items.push({ label: "Copy relative path", onSelect: copy(relative, "Relative path") });
      if (currentWorkspace() !== null) items.push({ label: "Open in file viewer", onSelect: () => openFileAction(relative) });
    }
  } else if (source?.kind === "url" && /^https?:/i.test(source.url)) {
    items.push({ label: "Copy URL", onSelect: copy(source.url, "URL") });
  }
  if (media) {
    const noun = media.kind;
    const fileName = source ? mediaFileName(source.kind === "file" ? source.path : source.url, "", noun) : noun;
    items.push({ label: `Save ${noun}`, disabled: source === null, onSelect: mediaAction(`Save ${noun}`, `Preparing ${noun} download\u2026`, "Download started", () => saveMedia(source, noun, fileName)) });
    if (noun === "image") items.push({ label: "Copy image", disabled: source === null, onSelect: mediaAction("Copy image", "Copying image\u2026", "Image copied", () => copyMediaImage(source)) });
  }
  return items;
}

export function showMediaMenu(source: MediaSource | null, cwd: string | null, at: { x: number; y: number }, media?: { kind: "image" | "video"; name: string }) {
  const items = mediaMenuItems(source, cwd, media).filter((item) => !item.disabled);
  if (items.length > 0) void popupOverOverlay(items, at, "media menu");
}

const FRAME = "overflow-hidden rounded-lg border";

/** One image: loading box, the picture (a press expands it, a right press has the media menu), or "Image unavailable". */
function ImageBody(props: { image: TextViewImage; media: () => { source: MediaSource | null }; ctx: MediaContext }) {
  const url = mediaUrlState(() => props.media().source, () => "image");
  const natural = signal<{ width: number; height: number } | null>(null);
  const broken = signal(false);
  effect(() => { props.media().source; broken.set(false); natural.set(null); });
  const alt = () => props.image.alt ?? "";
  const authored = () => authoredImageSize(props.image.width as never, props.image.height as never);
  const size = () => fitMedia(natural(), authored());
  const srcUrl = () => { const state = url.state(); return state.kind === "ready" ? state.url : ""; };
  const unavailable = () => broken() || url.state().kind === "failed";
  const open = () => {
    const items = props.ctx.gallery();
    const source = props.media().source;
    const found = galleryIndexOf(items, source);
    if (found >= 0) expandMedia({ items, index: found });
    else if (source) expandMedia({ items: [{ name: mediaPreviewName(alt()), kind: "image", source }], index: 0 });
  };
  return unavailable() ? (
    <MediaFallback kind="image" alt={alt()} />
  ) : (
    <View
      class={FRAME}
      style={[frameBorder(), size() ? { width: size()!.width, height: size()!.height } : { width: 240, height: 135 }]}
      role="button"
      accessibilityLabel={`Preview ${mediaPreviewName(alt())}`}
      tooltip={props.image.title}
      onPress={open}
      onContextMenu={((event: { pagePosition: { x: number; y: number } }) => showMediaMenu(props.media().source, props.ctx.cwd(), event.pagePosition, { kind: "image", name: alt() })) as never}
    >
      {url.state().kind === "ready" ? (
        <Image
          src={srcUrl()}
          accessibilityLabel={alt() || "image"}
          onLoad={(event) => natural.set({ width: event.size.width, height: event.size.height })}
          onError={() => broken.set(true)}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      ) : (
        <View class="size-full items-center justify-center bg-muted-40" accessibilityLabel="Loading image" />
      )}
    </View>
  );
}

function VideoBody(props: { image: TextViewImage; media: () => { source: MediaSource | null }; ctx: MediaContext }) {
  const url = mediaUrlState(() => props.media().source, () => "video");
  const broken = signal(false);
  const natural = signal<{ width: number; height: number } | null>(null);
  effect(() => { props.media().source; broken.set(false); });
  const alt = () => props.image.alt ?? "";
  const srcUrl = () => { const state = url.state(); return state.kind === "ready" ? state.url : ""; };
  const size = () => fitMedia(natural(), authoredImageSize(props.image.width as never, props.image.height as never)) ?? { width: 480, height: 270 };
  const webLink = () => { const source = props.media().source; return source?.kind === "url" ? openMediaLink({ src: source.url }) : null; };
  return broken() || url.state().kind === "failed" ? (
    <View class="gap-2 self-start">
      <MediaFallback kind="video" alt={alt()} />
      {webLink() ? (
        <View role="button" accessibilityLabel={webLink()!.label} onPress={() => void openUrl(webLink()!.url).catch(() => undefined)} class="h-7 self-start flex-row items-center rounded-md bg-secondary px-2.5 hover:bg-accent">
          <Text class="text-xs font-medium text-secondary-foreground">{webLink()!.label}</Text>
        </View>
      ) : null}
    </View>
  ) : (
    <View
      class={`${FRAME} bg-black`}
      style={[frameBorder(), { width: size().width, height: size().height }]}
      accessibilityLabel={`Video ${mediaPreviewName(alt(), "video")}`}
      onContextMenu={((event: { pagePosition: { x: number; y: number } }) => showMediaMenu(props.media().source, props.ctx.cwd(), event.pagePosition, { kind: "video", name: alt() })) as never}
    >
      {url.state().kind === "ready" ? (
        <Video src={srcUrl()} controls paused class="size-full" onLoad={(event) => natural.set({ width: event.size.width, height: event.size.height })} onError={() => broken.set(true)} accessibilityLabel={alt() || "video"} />
      ) : (
        <View class="size-full items-center justify-center" accessibilityLabel="Loading video" />
      )}
    </View>
  );
}

/** InlineAudioPreview: a play button, the file's name and the clock; the sound plays through a 1pt player. */
function AudioBody(props: { image: TextViewImage; media: () => { source: MediaSource | null }; name: string }) {
  const url = mediaUrlState(() => props.media().source, () => "audio");
  const playing = signal(false);
  const position = signal({ time: 0, duration: 0 });
  const broken = signal(false);
  const srcUrl = () => { const state = url.state(); return state.kind === "ready" ? state.url : ""; };
  const unavailable = () => broken() || url.state().kind === "failed";
  return (
    <View class="w-64 max-w-full flex-row items-center gap-2 rounded-lg border py-2 pe-2 ps-2" style={frameBorder()} accessibilityLabel={`Audio ${props.name}`}>
      <View
        class="size-9 shrink-0 items-center justify-center rounded-full bg-background hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
        disabled={unavailable() || url.state().kind !== "ready"}
        role="button"
        accessibilityLabel={playing() ? "Pause audio" : "Play audio"}
        onPress={() => playing.update((value) => !value)}
      >
        <TimelineIcon name={playing() ? "pause" : "play"} size={14} />
      </View>
      <View class="min-w-0 flex-1">
        <Text class="truncate text-sm font-medium text-foreground">{props.name}</Text>
        <Text class="text-xs tabular-nums text-muted-foreground">{unavailable() ? "Audio unavailable" : `${formatClock(position().time)} / ${formatClock(position().duration)}`}</Text>
      </View>
      {url.state().kind === "ready" && !broken() ? (
        <Video
          src={srcUrl()}
          paused={!playing()}
          style={{ width: 1, height: 1 }}
          onLoad={(event) => position.update((current) => ({ ...current, duration: event.duration }))}
          onProgress={(event) => position.set({ time: event.currentTime, duration: event.duration })}
          onEnd={() => { playing.set(false); position.update((current) => ({ ...current, time: 0 })); }}
          onError={() => broken.set(true)}
        />
      ) : null}
    </View>
  );
}

const sourcePath = (source: MediaSource | null): string | null => (source !== null && source.kind === "file" ? source.path : null);

/** The renderer TextView calls for each `![alt](src)`: by the source's type an image, a video, an audio clip or a file chip. */
export function MarkdownImage(props: { image: TextViewImage; ctx: MediaContext }) {
  const resolved = () => resolveMarkdownMedia(props.image.src, props.ctx.cwd(), props.ctx.threadId());
  const alt = () => props.image.alt ?? "";
  const fileMeta = () => (resolved().plainFile ? resolveMarkdownFileLinkMeta(props.image.src, props.ctx.cwd()) : null);
  const copy = () => markdownImageCopy(alt(), props.image.src, props.image.title);
  void copy;
  return (
    <>
      {resolved().blocked || (resolved().source === null && !fileMeta()) ? (
        <MediaFallback kind={resolved().kind} alt={alt()} />
      ) : fileMeta() ? (
        <FileChip data={() => ({ meta: fileMeta()!, href: props.image.src, label: fileMeta()!.basename, copyMarkdown: copy(), inlineCode: false })} threadId={props.ctx.threadId} />
      ) : resolved().kind === "audio" ? (
        <AudioBody image={props.image} media={() => ({ source: resolved().source })} name={mediaFileName(sourcePath(resolved().source) ?? props.image.src, alt())} />
      ) : resolved().kind === "video" ? (
        <VideoBody image={props.image} media={() => ({ source: resolved().source })} ctx={props.ctx} />
      ) : (
        <ImageBody image={props.image} media={() => ({ source: resolved().source })} ctx={props.ctx} />
      )}
    </>
  );
}

// ---- Codex artifact templates ----

const TEMPLATE_ICON: Record<CodexArtifactTemplateKind, string> = {
  document: "file-text", presentation: "presentation", spreadsheet: "file-spreadsheet", site: "globe", "google-docs": "file-text", "google-slides": "presentation",
  "google-sheets": "file-spreadsheet", image: "image", email: "mail", slack: "message-square",
};

/** CodexArtifactTemplateCard: a template's name and kind, with Use template when the caller can take the prompt. */
export function ArtifactTemplateCard(props: { template: () => CodexArtifactTemplate; onUse?: (template: CodexArtifactTemplate) => void }) {
  const label = () => codexArtifactTemplatePresentationLabel(props.template().artifactKind);
  return (
    <View class="my-[0.65rem] w-full min-w-0 flex-row items-center gap-3 rounded-xl border border-border-70 px-3 py-2.5" style={{ backgroundColor: tokenAlpha("card", 0.6) }} role="group" accessibilityLabel={`${props.template().displayName} template`}>
      <View class="min-w-0 flex-1 flex-row items-center gap-3">
        <View class="size-9 shrink-0 items-center justify-center rounded-lg border border-border-70 bg-background">
          <TimelineIcon name={TEMPLATE_ICON[props.template().artifactKind]} size={20} tint="#a3a3a3" />
          <View class="absolute -right-1 -bottom-1 size-4 items-center justify-center rounded-full border border-background bg-primary"><TimelineIcon name="sparkles" size={10} tint="#ffffff" /></View>
        </View>
        <View class="min-w-0 flex-1">
          <Text class="truncate text-sm font-medium text-foreground">{props.template().displayName}</Text>
          <Text class="text-xs text-muted-foreground">{label()}</Text>
        </View>
      </View>
      {props.onUse ? (
        <View class="h-8 shrink-0 items-center justify-center rounded-lg border border-input bg-popover px-3 hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out" role="button" accessibilityLabel="Use template" onPress={() => props.onUse?.(props.template())}>
          <Text class="text-sm font-medium text-foreground">Use template</Text>
        </View>
      ) : null}
    </View>
  );
}
