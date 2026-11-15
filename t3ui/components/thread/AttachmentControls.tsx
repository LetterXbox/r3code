import { FileEntryIcon } from "../files/FileEntryIcon";
import { effect, Image, Picker, signal, Text, Video, View } from "nsh";
import { canPickFolder as canPickFiles, pickFiles } from "../../desktop/dialogs";
import { backendUrl, openThread } from "../../store";
import { formatAttachmentUploadProgress, isVideoAttachment } from "../../backend/attachments";
import { openAttachmentAction } from "../rightPanel/panelState";
import { ComposerFilePreviewDialog } from "../composer/ComposerFilePreviewDialog";
import { ComposerIcon } from "../composer/ComposerIcon";
import { expandMedia } from "./markdown/ExpandedMedia";
import { isSnapShotAttachment, snapShotArrivalStyle } from "../../desktop/snapShotArrival";
import { snapShotSourceFor } from "../../desktop/snapShotSource";
import { SnapShotAttachmentDetails } from "./SnapShotDetails";
import paperclip from "./paperclip.svg";
import type { DraftAttachment } from "../../store";

export type AttachmentDisplay = DraftAttachment;

/** IMAGE_ATTACHMENT_MAX_EDGE (client-runtime imageAttachmentSize.ts). */
const IMAGE_ATTACHMENT_MAX_EDGE = 2000;

/** The error the store gives a restored draft attachment whose bytes are gone (store.ts draft restore). */
export const REATTACH_ERROR = "Choose this file again to retry the upload.";

function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const thumbnailUrls = new Map<string, string>();

/** The staged image's own pixels: an object URL made once per attachment. */
function thumbnailUrl(id: string, file: File | undefined): string | null {
  const known = thumbnailUrls.get(id);
  if (known) return known;
  if (!file) return null;
  try {
    const url = URL.createObjectURL(file);
    thumbnailUrls.set(id, url);
    return url;
  } catch { return null; }
}

export function AttachmentList(props: {
  items: () => AttachmentDisplay[];
  /** The bytes behind an attachment, so an image tile shows the image; without them it shows the name. */
  fileFor?: (id: string) => File | undefined;
  /** The server's id for an uploaded attachment, so a file whose bytes are gone still previews (and a video still plays). */
  uploadedIdFor?: (id: string) => string | undefined;
  disabled: () => boolean;
  onRemove: (id: string) => void;
  onRetry: (id: string) => Promise<void>;
  /** The server's file upload limit (null: files not accepted), for "Attach again" vs "Remove to send". */
  fileLimit?: () => number | null;
}) {
  const error = signal("");
  // composerFileNeedsReattach: a restored draft attachment whose bytes did not survive (the store marks it failed with
  // this message): it reads "Attach again" (or "Remove to send" when the server could not take it) and has no Retry.
  // ComposerAttachmentStrip: Preview opens the expanded gallery of every draft image, at the one pressed.
  const openGallery = (id: string) => {
    const shown = images().flatMap((image) => { const url = thumbnailUrl(image.id, props.fileFor?.(image.id)); return url ? [{ id: image.id, item: { name: image.name, kind: "image" as const, source: { kind: "url" as const, url } } }] : []; });
    const index = shown.findIndex((entry) => entry.id === id);
    if (index >= 0) expandMedia({ items: shown.map((entry) => entry.item), index });
  };
  const needsReattach = (item: AttachmentDisplay) => item.status === "failed" && item.error === REATTACH_ERROR && !props.fileFor?.(item.id);
  const reattachLabel = (item: AttachmentDisplay) => {
    const limit = props.fileLimit?.();
    return item.kind === "file" && (limit === null || (limit !== undefined && item.sizeBytes > limit)) ? "Remove to send" : "Attach again";
  };
  // nonPersistedImageIdSet: staged bytes not yet on the server are not saved with the draft.
  const mayNotPersist = (item: AttachmentDisplay) => item.status !== "uploaded" && Boolean(props.fileFor?.(item.id));
  async function retry(id: string) {
    const scope = JSON.stringify([backendUrl(), openThread()?.id ?? ""]);
    try { await props.onRetry(id); }
    catch (cause) {
      if (scope === JSON.stringify([backendUrl(), openThread()?.id ?? ""])) error.set(cause instanceof Error ? cause.message : String(cause));
    }
  }
  const images = () => props.items().filter((item) => item.kind === "image");
  // isPreviewableComposerVideo / composerOtherFilesForPresentation: a video that still has its bytes or an upload is a tile; the rest are rows.
  const videos = () => props.items().filter((item) => item.kind !== "image" && isVideoAttachment(item) && (Boolean(props.fileFor?.(item.id)) || Boolean(props.uploadedIdFor?.(item.id))));
  const files = () => { const tiles = new Set(videos().map((item) => item.id)); return props.items().filter((item) => item.kind !== "image" && !tiles.has(item.id)); };
  const previewId = signal<string | null>(null);
  const previewFile = () => {
    const item = files().find((entry) => entry.id === previewId());
    if (!item) return null;
    const bytes = props.fileFor?.(item.id);
    const uploaded = props.uploadedIdFor?.(item.id);
    // A file with neither its bytes nor an upload has nothing to show.
    return bytes || uploaded ? { id: bytes ? item.id : uploaded!, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes, ...(bytes ? { file: bytes } : {}) } : null;
  };
  // expandVideo: bytes still on this computer play in the expanded viewer; an uploaded-only video opens as an attachment tab.
  const playVideo = (item: AttachmentDisplay) => {
    const bytes = props.fileFor?.(item.id);
    if (bytes) {
      const url = thumbnailUrl(item.id, bytes);
      if (url) expandMedia({ items: [{ name: item.name, kind: "video", source: { kind: "url", url } }], index: 0 });
      return;
    }
    const uploaded = props.uploadedIdFor?.(item.id);
    if (uploaded) openAttachmentAction({ id: uploaded, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes });
  };
  const status = (item: AttachmentDisplay) =>
    needsReattach(item) ? reattachLabel(item) : item.status === "uploaded" ? sizeLabel(item.sizeBytes) : item.status === "failed" ? (item.error ?? "Upload failed") : item.status === "uploading" ? formatAttachmentUploadProgress(item.progress ?? 0) : "Waiting to upload";
  // ComposerAttachmentStrip tile overlay: the percentage while uploading, 0% while waiting to upload.
  const tileProgress = (item: AttachmentDisplay) => formatAttachmentUploadProgress(item.status === "uploading" ? (item.progress ?? 0) : 0);
  return (
    <View class="mb-3 gap-1">
      {images().length ? (
        // ComposerAttachmentMediaRow: 64pt tiles, the name as the fallback, a close chip top right.
        <View class="flex-row flex-wrap gap-2">
          <Each of={images()} key={(item) => item.id}>
            {(item) => {
              // A SnapShot tile (ComposerAttachmentStrip SnapShotAttachmentFrame): 208 x 112, arrives with a scale and fade, close shows on hover.
              const snap = isSnapShotAttachment(item().name);
              const hovered = signal(false);
              const arrival = snap ? snapShotArrivalStyle(item().name) : undefined;
              return (
              <View class={`relative overflow-hidden rounded-lg border border-border bg-background ${snap ? "h-28 w-52 max-w-full" : "size-16"}`} style={arrival} testID={snap ? "SnapShot attachment" : undefined} onMouseEnter={snap ? () => hovered.set(true) : undefined} onMouseLeave={snap ? () => hovered.set(false) : undefined}>
                {thumbnailUrl(item().id, props.fileFor?.(item().id)) ? (
                  <View class="size-full" onPress={() => openGallery(item().id)} accessibilityLabel={`Preview ${item().name}`} role="button">
                    <Image src={thumbnailUrl(item().id, props.fileFor?.(item().id))!} accessibilityLabel={item().name} style={{ objectFit: "cover" }} class="size-full" />
                  </View>
                ) : (
                  <View class="size-full items-center justify-center px-1" accessibilityLabel={`Preview ${item().name}`}>
                    <Text class="text-center text-3xs text-muted-foreground">{item().name}</Text>
                  </View>
                )}
                {snap && snapShotSourceFor(item().name) ? <SnapShotAttachmentDetails source={snapShotSourceFor(item().name)!} /> : null}
                {(item().status === "uploading" || item().status === "ready") && !needsReattach(item()) ? (
                  <View class="absolute inset-x-0 bottom-0 bg-background px-1" style={{ pointerEvents: "none" }}><Text class="text-center text-3xs text-foreground">{tileProgress(item())}</Text></View>
                ) : null}
                {mayNotPersist(item()) ? (
                  <View class="absolute left-1 top-1 items-center justify-center rounded bg-background p-0.5" accessibilityLabel="Draft attachment may not persist" tooltip="Draft attachment could not be saved locally and may be lost on navigation.">
                    <ComposerIcon name="circle-alert" size={12} />
                  </View>
                ) : null}
                {item().status === "failed" && !needsReattach(item()) ? (
                  <View onPress={() => void retry(item().id)} disabled={props.disabled()} accessibilityLabel={`Retry ${item().name}`} tooltip={item().error ?? "Upload failed"} role="button" class="absolute bottom-1 left-1 rounded-md bg-background px-1">
                    <Text class="text-3xs text-foreground">Retry</Text>
                  </View>
                ) : null}
                <View onPress={() => props.onRemove(item().id)} disabled={props.disabled()} accessibilityLabel={`Remove ${item().name}`} role="button" class={`absolute right-1 top-1 size-5 items-center justify-center rounded-full bg-background ${snap ? "transition-opacity" : ""}`} style={snap ? { opacity: hovered() ? 1 : 0 } : undefined}>
                  <ComposerIcon name="x" size={12} />
                </View>
              </View>
              );
            }}
          </Each>
        </View>
      ) : null}
      {videos().length ? (
        // ComposerAttachmentMediaRow's video tile: 64pt on black, the first frame under a play mark, retry and remove.
        <View class="flex-row flex-wrap gap-2">
          <Each of={videos()} key={(item) => item.id}>
            {(item) => {
              const url = () => thumbnailUrl(item().id, props.fileFor?.(item().id));
              return (
                <View class="relative size-16 overflow-hidden rounded-lg border border-border bg-black">
                  {url() ? <View class="absolute inset-0" style={{ pointerEvents: "none" }}><Video src={url()!} paused muted class="size-full" /></View> : null}
                  <View class="size-full items-center justify-center" onPress={() => playVideo(item())} accessibilityLabel={`Play ${item().name}`} role="button">
                    <ComposerIcon name="play" size={16} tint="#ffffff" />
                  </View>
                  {item().status === "uploading" ? (
                    <View class="absolute inset-x-0 bottom-0 bg-background px-1" style={{ pointerEvents: "none" }}><Text class="text-center text-3xs text-foreground">{tileProgress(item())}</Text></View>
                  ) : null}
                  {item().status === "failed" && !needsReattach(item()) ? (
                    <View onPress={() => void retry(item().id)} disabled={props.disabled()} accessibilityLabel={`Retry ${item().name}`} tooltip={item().error ?? "Upload failed"} role="button" class="absolute bottom-1 left-1 rounded-md bg-background px-1">
                      <Text class="text-3xs text-foreground">Retry</Text>
                    </View>
                  ) : null}
                  <View onPress={() => props.onRemove(item().id)} disabled={props.disabled()} accessibilityLabel={`Remove ${item().name}`} role="button" class="absolute right-1 top-1 size-5 items-center justify-center rounded-full bg-background">
                    <ComposerIcon name="x" size={12} />
                  </View>
                </View>
              );
            }}
          </Each>
        </View>
      ) : null}
      <Each of={images().filter((item) => item.status === "failed")} key={(item) => item.id}>
        {(item) => <Text class="text-xs text-destructive">{item().name}: {status(item())}</Text>}
      </Each>
      {files().length ? (
        // ComposerAttachmentFileList: icon, name, size and a ghost close.
        <View class="gap-1">
          <Each of={files()} key={(item) => item.id}>
            {(item) => (
              <View class="min-w-0 flex-row items-center gap-2 py-1">
                <FileEntryIcon path={item().name} kind="file" size={16} />
                <View class="min-w-0 flex-1" onPress={() => previewId.set(item().id)} disabled={needsReattach(item())} accessibilityLabel={`Preview ${item().name}`} role="button">
                  <Text class="truncate text-sm text-foreground">{item().name}</Text>
                </View>
                <Text class={item().status === "failed" && !needsReattach(item()) ? "shrink-0 text-xs text-destructive" : "shrink-0 text-xs text-muted-foreground"}>{status(item())}</Text>
                {item().status === "failed" && !needsReattach(item()) ? (
                  <View onPress={() => void retry(item().id)} disabled={props.disabled()} accessibilityLabel={`Retry ${item().name}`} role="button" class="rounded-md px-1">
                    <Text class="text-xs text-foreground">Retry</Text>
                  </View>
                ) : null}
                <View onPress={() => props.onRemove(item().id)} disabled={props.disabled()} accessibilityLabel={`Remove ${item().name}`} role="button" class="size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out">
                  <ComposerIcon name="x" size={12} />
                </View>
              </View>
            )}
          </Each>
        </View>
      ) : null}
      {error() ? <Text class="text-xs text-destructive">{error()}</Text> : null}
      <ComposerFilePreviewDialog
        file={() => { const current = previewFile(); return current ? { id: current.id, name: current.name, mimeType: current.mimeType, sizeBytes: current.sizeBytes, ...(current.file ? { file: current.file } : {}) } : null; }}
        onRemove={() => { const id = previewId(); if (id) props.onRemove(id); }}
        onClose={() => previewId.set(null)}
      />
    </View>
  );
}

export function AttachmentControl(props: {
  enabled: () => boolean;
  filesAllowed: () => boolean;
  onAddFile: (file: File) => Promise<void>;
  onAddPath: (path: string) => Promise<void>;
}) {
  const error = signal("");
  const pending = signal(false);
  let previousScope = "";
  const scope = () => JSON.stringify([backendUrl(), openThread()?.id ?? ""]);
  effect(() => {
    const current = scope();
    if (current === previousScope) return;
    previousScope = current;
    error.set("");
  });
  // ComposerAttachButton: one "Attach files" button that opens the system's multi-file picker. On macOS that is the
  // `choose file` dialog (NSH's Picker picks images only); elsewhere the system photo picker.
  async function chooseAttachments() {
    const originalScope = scope();
    if (pending() || !props.enabled()) return;
    pending.set(true);
    error.set("");
    try {
      if (canPickFiles()) {
        const paths = await pickFiles({ imagesOnly: !props.filesAllowed() });
        for (const path of paths) {
          if (scope() !== originalScope) return;
          await props.onAddPath(path);
        }
      } else {
        // prepareImageForAttachment: the picker is the one place this runtime re-encodes images, so the reference's 2000 px longest edge
        // and its HEIC / HEIF / TIFF to JPEG conversion happen here ("compatible" keeps JPEG, PNG, GIF and WebP as they are).
        const images = await Picker.pickImages({ multiple: true, maxDimension: IMAGE_ATTACHMENT_MAX_EDGE, format: "compatible" });
        for (const image of images) {
          if (scope() !== originalScope) return;
          await props.onAddFile(image.file);
        }
      }
    } catch (cause) {
      if (scope() === originalScope) error.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.set(false);
    }
  }

  return (
    <View class="gap-1">
      <View
        class="size-7 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
        onPress={() => void chooseAttachments()}
        disabled={!props.enabled() || pending()}
        accessibilityLabel={props.enabled() ? "Attach files" : "Attachments unavailable"}
        tooltip="Attach files"
        role="button"
      >
        <Image src={paperclip} class="size-3.5" />
      </View>
      {error() ? <Text class="text-xs text-destructive">{error()}</Text> : null}
    </View>
  );
}
