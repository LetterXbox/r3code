// Inline thumbnails and file cards for a message's attachments, ported from
// TimelineUserMessageRow.tsx (media block, UserFileCard) and chat/ComposerImageThumbnail.tsx.
// The bytes come through the same signed-asset reader the preview uses.
import { writeFile } from "fs/promises";
import { homedir } from "os";
import { showToast } from "../toast";
import { effect, Image, signal, Text, View } from "nsh";
import type { MessageAttachment } from "./AttachmentPreview";
import { COLLAGE_WIDTH, collageRows, fileCardDetail, LONE_IMAGE_HEIGHT, loneImageWidth, splitAttachments, THUMBNAIL_BYTES, userMessageFileLabel } from "./mediaLayout";
import { IconSlot } from "./markdown/TimelineIcon";
import { AudioAttachment, VideoAttachment } from "./MessagePlayers";
import { takeAttachmentPreviewHandoff } from "./attachmentPreviewHandoff";

export type AttachmentLoader = (attachmentId: string, options: { signal: AbortSignal; maxBytes: number }) => Promise<Blob>;

const urlCache = new Map<string, string>();
const imageSizes = new Map<string, { width: number; height: number }>();
const CACHE_LIMIT = 64;

function remember(id: string, url: string) {
  urlCache.set(id, url);
  if (urlCache.size > CACHE_LIMIT) {
    const oldest = urlCache.keys().next().value;
    if (oldest !== undefined) {
      const stale = urlCache.get(oldest);
      urlCache.delete(oldest);
      imageSizes.delete(oldest);
      if (stale) URL.revokeObjectURL(stale);
    }
  }
}

type ThumbState = { kind: "loading" } | { kind: "ready"; url: string } | { kind: "failed" };

/** One thumbnail: the real bytes, a cover-fit image, and the file name until (or instead of) them. */
export function Thumbnail(props: {
  attachment: MessageAttachment;
  load: AttachmentLoader;
  class: string;
  fit?: "cover" | "contain";
  onSize?: (size: { width: number; height: number }) => void;
  onOpen: (attachment: MessageAttachment) => void;
}) {
  const adopt = (id: string) => { const url = takeAttachmentPreviewHandoff(id); if (url) remember(id, url); return url; };
  const cached = urlCache.get(props.attachment.id) ?? adopt(props.attachment.id);
  const state = signal<ThumbState>(cached ? { kind: "ready", url: cached } : { kind: "loading" });
  effect(() => {
    const attachment = props.attachment;
    const hit = urlCache.get(attachment.id) ?? adopt(attachment.id);
    if (hit) { state.set({ kind: "ready", url: hit }); return; }
    if (!Number.isFinite(attachment.sizeBytes) || attachment.sizeBytes < 0 || attachment.sizeBytes > THUMBNAIL_BYTES) { state.set({ kind: "failed" }); return; }
    const controller = new AbortController();
    let active = true;
    void props.load(attachment.id, { signal: controller.signal, maxBytes: THUMBNAIL_BYTES }).then((blob) => {
      if (!active) return;
      const url = URL.createObjectURL(new Blob([blob], { type: attachment.mimeType }));
      remember(attachment.id, url);
      state.set({ kind: "ready", url });
    }).catch(() => { if (active && !controller.signal.aborted) state.set({ kind: "failed" }); });
    return () => { active = false; controller.abort(); };
  });
  const url = () => { const current = state(); return current.kind === "ready" ? current.url : ""; };
  return (
    <View
      class={`overflow-hidden bg-background ${props.class}`}
      onPress={() => props.onOpen(props.attachment)}
      accessibilityLabel={`Preview ${props.attachment.name}`}
      role="button"
    >
      {state().kind === "ready" ? (
        <Image
          src={url()}
          accessibilityLabel={props.attachment.name}
          onLoad={(event) => props.onSize?.({ width: event.size.width, height: event.size.height })}
          onError={() => state.set({ kind: "failed" })}
          style={{ objectFit: props.fit ?? "cover" }}
          class="size-full"
        />
      ) : (
        <View class="min-h-[72px] flex-1 items-center justify-center px-2 py-3">
          <Text class="text-center text-2xs text-muted-foreground">{props.attachment.name}</Text>
        </View>
      )}
    </View>
  );
}

/** Several images share one rounded shape, split by hairlines. */
function Collage(props: { images: MessageAttachment[]; load: AttachmentLoader; onOpen: (attachment: MessageAttachment) => void }) {
  const layout = () => collageRows(props.images.length);
  const cell = (index: number, extra: string) => (
    <Thumbnail attachment={props.images[index]} load={props.load} onOpen={props.onOpen} class={extra} fit="cover" />
  );
  return (
    <View class="overflow-hidden rounded-2xl bg-border-60" style={{ width: COLLAGE_WIDTH, maxWidth: "100%", height: layout().height }} accessibilityLabel="Image attachments">
      {layout().kind === "trio" ? (
        <View class="flex-1 flex-row gap-px">
          <View class="flex-[3]">{cell(0, "flex-1")}</View>
          <View class="flex-[2] gap-px">{cell(1, "flex-1")}{cell(2, "flex-1")}</View>
        </View>
      ) : (
        <View class="flex-1 gap-px">
          <Each of={layout().rows} key={(row) => row.join("-")}>
            {(row) => (
              <View class="flex-1 flex-row gap-px">
                <Each of={row()} key={(index) => String(index)}>{(index) => cell(index(), "flex-1")}</Each>
              </View>
            )}
          </Each>
        </View>
      )}
    </View>
  );
}

/** UserFileCard: a w-64 rounded-2xl card with the file's icon, name, extension and size. */
/** UserFileCard's Download: the file's bytes are written to Downloads (the app has no save dialog), with a toast either way. */
export async function downloadAttachment(attachment: MessageAttachment, load: AttachmentLoader, write: (path: string, data: Uint8Array) => Promise<void> = (path, data) => writeFile(path, data)): Promise<string | null> {
  const path = `${homedir()}/Downloads/${attachment.name.replace(/[\\/]/g, "_")}`;
  try {
    const blob = await load(attachment.id, { signal: new AbortController().signal, maxBytes: Math.max(attachment.sizeBytes, 1) });
    await write(path, new Uint8Array(await blob.arrayBuffer()));
    showToast({ type: "success", title: `Saved ${userMessageFileLabel(attachment)}`, description: path });
    return path;
  } catch (cause) {
    showToast({ type: "error", title: "Could not save file", description: cause instanceof Error ? cause.message : "Please try again." });
    return null;
  }
}

function FileCard(props: { attachment: MessageAttachment; onOpen: (attachment: MessageAttachment) => void; sending?: boolean; onDownload?: (attachment: MessageAttachment) => void }) {
  const label = () => userMessageFileLabel(props.attachment);
  return (
    <View
      class={`w-64 max-w-full flex-row items-center gap-1 rounded-2xl bg-message-surface py-2 pe-1 ps-2 ${props.sending ? "" : "hover:bg-accent"}`}
      onPress={props.sending ? undefined : () => props.onOpen(props.attachment)}
      accessibilityLabel={props.sending ? `${label()}, sending` : `Preview ${label()}`}
      role={props.sending ? undefined : "button"}
    >
      <View class="size-9 shrink-0 items-center justify-center rounded-lg bg-background">
        <IconSlot name="file" size={18} />
      </View>
      <View class="min-w-0 flex-1">
        <Text class="truncate text-sm font-medium text-message-foreground">{label()}</Text>
        <Text class="text-xs tabular-nums text-muted-foreground">{fileCardDetail(props.attachment, props.sending === true)}</Text>
      </View>
      {props.sending ? (
        <View class="size-6 items-center justify-center opacity-50" accessibilityLabel="Sending attachment" disabled>
          <IconSlot name="download" size={14} />
        </View>
      ) : props.onDownload ? (
        <View class="size-6 items-center justify-center rounded-md hover:bg-accent" role="button" accessibilityLabel={`Download ${label()}`} tooltip={`Download ${label()}`} onPress={() => props.onDownload?.(props.attachment)}>
          <IconSlot name="download" size={14} />
        </View>
      ) : null}
    </View>
  );
}

/** The media block: images as thumbnails or a collage, then file cards, aligned to the message's side. */
export function MessageMedia(props: {
  attachments: () => MessageAttachment[];
  load: AttachmentLoader;
  onOpen: (attachment: MessageAttachment) => void;
  /** The message is an optimistic echo the server has not stored yet: its files read "Sending…". */
  sending?: () => boolean;
}) {
  const split = () => splitAttachments(props.attachments());
  return (
    <View class="max-w-full items-end gap-2" accessibilityLabel="Message attachments">
      {split().images.length === 1 ? <LoneImageFrame attachment={split().images[0]} load={props.load} onOpen={props.onOpen} /> : null}
      {split().images.length > 1 ? <Collage images={split().images} load={props.load} onOpen={props.onOpen} /> : null}
      <Each of={split().videos} key={(attachment) => attachment.id}>
        {(attachment) => <VideoAttachment attachment={attachment} load={props.load} />}
      </Each>
      <Each of={split().audio} key={(attachment) => attachment.id}>
        {(attachment) => <AudioAttachment attachment={attachment} load={props.load} />}
      </Each>
      <Each of={split().files} key={(attachment) => attachment.id}>
        {(attachment) => <FileCard attachment={attachment()} onOpen={props.onOpen} sending={props.sending?.() === true} onDownload={(file) => void downloadAttachment(file, props.load)} />}
      </Each>
    </View>
  );
}

function LoneImageFrame(props: { attachment: MessageAttachment; load: AttachmentLoader; onOpen: (attachment: MessageAttachment) => void }) {
  const size = signal<{ width: number; height: number } | null>(imageSizes.get(props.attachment.id) ?? null);
  const rememberSize = (next: { width: number; height: number }) => {
    if (next.width <= 0 || next.height <= 0) return;
    const current = size();
    if (current?.width === next.width && current.height === next.height) return;
    imageSizes.set(props.attachment.id, next);
    size.set(next);
  };
  return (
    <View style={{ height: LONE_IMAGE_HEIGHT, width: loneImageWidth(size()), maxWidth: "100%" }}>
      <Thumbnail attachment={props.attachment} load={props.load} onOpen={props.onOpen} onSize={rememberSize} class="flex-1 rounded-2xl" fit="cover" />
    </View>
  );
}
