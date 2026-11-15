import { effect, Image, keymap, Scroll, signal, Text, View, windowSize } from "nsh";
import type { Message } from "../../store";
import { Icon } from "../Icons";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { keepPressInDialog } from "../dialogSurface";
import { Dialog } from "nsh/base";
import { attachmentPreviewSize } from "./attachmentPreviewLayout";

export type MessageAttachment = NonNullable<Message["attachments"]>[number];
type PreviewState =
  | { kind: "loading" }
  | { kind: "image"; url: string }
  | { kind: "text"; content: string }
  | { kind: "unavailable"; reason: string };

const IMAGE_LIMIT = 10 * 1024 * 1024;
const TEXT_LIMIT = 2 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const TEXT_TYPES = ["application/json", "application/xml", "application/javascript", "application/x-yaml"];

function previewKind(attachment: MessageAttachment): "image" | "text" | "unsupported" {
  const mime = attachment.mimeType.toLowerCase().split(";")[0].trim();
  if (attachment.type === "image" && IMAGE_TYPES.includes(mime)) return "image";
  if (mime.startsWith("text/") || TEXT_TYPES.includes(mime)) return "text";
  return "unsupported";
}

export function AttachmentPreview(props: {
  attachment: () => MessageAttachment;
  onClose: () => void;
  load: (attachmentId: string, options: { signal: AbortSignal; maxBytes: number }) => Promise<Blob>;
}) {
  const state = signal<PreviewState>({ kind: "loading" });
  const retry = signal(0);
  const naturalSize = signal({ width: 512, height: 192 });
  const imageUrl = () => { const current = state(); return current.kind === "image" ? current.url : ""; };
  const textContent = () => { const current = state(); return current.kind === "text" ? current.content : ""; };
  const canRetry = () => {
    const attachment = props.attachment();
    const kind = previewKind(attachment);
    return kind !== "unsupported" && attachment.sizeBytes >= 0 && attachment.sizeBytes <= (kind === "image" ? IMAGE_LIMIT : TEXT_LIMIT);
  };
  const reason = () => { const current = state(); return current.kind === "unavailable" ? current.reason : ""; };
  effect(() => keymap.bind({ escape: props.onClose }, { when: "always" }));
  const fittedSize = () => {
    return attachmentPreviewSize(windowSize(), naturalSize());
  };
  // A WebView draws above this overlay unless it steps aside.
  useOverlayOpen(true, "attachment preview");
  effect(() => {
    const attachment = props.attachment();
    retry();
    const kind = previewKind(attachment);
    const limit = kind === "image" ? IMAGE_LIMIT : TEXT_LIMIT;
    const controller = new AbortController();
    let active = true;
    let objectUrl = "";
    if (kind === "unsupported") {
      state.set({ kind: "unavailable", reason: "Preview is not available for this file type." });
    } else if (!Number.isFinite(attachment.sizeBytes) || attachment.sizeBytes < 0 || attachment.sizeBytes > limit) {
      state.set({ kind: "unavailable", reason: kind === "image" ? "This image is too large to preview." : "This file is too large to preview." });
    } else {
      state.set({ kind: "loading" });
      void props.load(attachment.id, { signal: controller.signal, maxBytes: limit }).then(async (blob) => {
        if (!active) return;
        if (blob.size > limit) throw new Error("The attachment is too large to preview.");
        if (kind === "image") {
          objectUrl = URL.createObjectURL(new Blob([blob], { type: attachment.mimeType }));
          naturalSize.set({ width: 512, height: 192 });
          if (active) state.set({ kind: "image", url: objectUrl });
        } else {
          const content = await blob.text();
          if (active) state.set({ kind: "text", content });
        }
      }).catch((cause: unknown) => {
        if (active && !controller.signal.aborted) state.set({ kind: "unavailable", reason: cause instanceof Error ? cause.message : String(cause) });
      });
    }
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  });

  return (
    <Dialog open animation="fade" testID="Attachment preview overlay" backdropTestID="Attachment preview backdrop"
      onOpenChange={({ open }) => { if (!open) props.onClose(); }}
      backdropStyle={{ backgroundColor: "rgba(0,0,0,0.75)" }}
      style={{ margin: "auto", width: "92%", height: "92%", alignItems: "center", justifyContent: "center" }}>
      <View class="absolute right-0 top-0 size-8 items-center justify-center rounded-lg border border-border"
        style={{ backgroundColor: "rgba(0,0,0,0.8)" }}
        onPress={props.onClose} accessibilityLabel="Close attachment preview" role="button">
        <Icon name="x" size={16} tint="#ffffff" />
      </View>
      {previewKind(props.attachment()) === "image" ? (
        <View class="max-w-full items-center gap-2" onPress={keepPressInDialog} testID="Attachment media group">
          {state().kind === "image" ? (
            <View class="overflow-hidden rounded-lg border border-border" style={fittedSize()}>
              <Image src={imageUrl()} accessibilityLabel="Attachment image preview" fadeDuration={0} onLoad={(event) => naturalSize.set(event.size)}
                onError={() => state.set({ kind: "unavailable", reason: "This image could not be displayed." })}
                style={{ ...fittedSize(), objectFit: "contain" }} />
            </View>
          ) : (
            <View class="h-48 w-full max-w-[512px] items-center justify-center gap-3 rounded-lg border border-border bg-black p-6">
              <Text class="text-center text-sm" style={{ color: "#ffffff" }}>{state().kind === "loading" ? "Loading preview..." : reason()}</Text>
              {state().kind === "unavailable" && canRetry() ? <View onPress={() => retry.update((value) => value + 1)} accessibilityLabel="Retry attachment preview" role="button" class="rounded-md border border-border px-3 py-1.5"><Text class="text-xs" style={{ color: "#ffffff" }}>Retry</Text></View> : null}
            </View>
          )}
          <Text class="max-w-full truncate text-center text-xs" style={{ color: "rgba(255,255,255,0.8)" }}>{props.attachment().name}</Text>
        </View>
      ) : (
        <View class="h-full w-full max-w-[800px] overflow-hidden rounded-xl border border-border bg-background" onPress={keepPressInDialog}>
          <View class="h-12 flex-row items-center border-b border-border px-4"><Text class="truncate text-sm font-medium text-foreground">{props.attachment().name}</Text></View>
          {state().kind === "text" ? (
            <Scroll class="min-h-0 flex-1" contentClass="p-4"><View selectable><Text class="font-mono text-sm text-foreground">{textContent()}</Text></View></Scroll>
          ) : (
            <View class="flex-1 items-center justify-center gap-3 px-8">
              <Text class="text-center text-sm text-muted-foreground">{state().kind === "loading" ? "Loading preview..." : reason()}</Text>
              {state().kind === "unavailable" && canRetry() ? <View onPress={() => retry.update((value) => value + 1)} accessibilityLabel="Retry attachment preview" role="button" class="rounded-md border border-border px-3 py-1.5"><Text class="text-xs text-foreground">Retry</Text></View> : null}
            </View>
          )}
        </View>
      )}
    </Dialog>
  );
}
