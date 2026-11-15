// A message's video and audio attachments (TimelineUserMessageRow.tsx UserVideoAttachment, files/InlineAudioPreview.tsx): the bytes
// come through the signed-asset reader like a thumbnail's, then play in the platform's player. A file that cannot load keeps its name
// on the reference's black 4:3 card.
import { effect, signal, Text, Video, View } from "nsh";
import type { MessageAttachment } from "./AttachmentPreview";
import { COLLAGE_WIDTH, formatClock, PLAYER_BYTES } from "./mediaLayout";
import type { AttachmentLoader } from "./MessageMedia";
import { TimelineIcon } from "./markdown/TimelineIcon";

type Source = { kind: "loading" } | { kind: "ready"; url: string } | { kind: "failed" };

/** The attachment's bytes as an object URL, released when it changes or the row goes. */
function useAttachmentUrl(attachment: () => MessageAttachment, load: AttachmentLoader) {
  const state = signal<Source>({ kind: "loading" });
  const retry = signal(0);
  effect(() => {
    const current = attachment();
    retry();
    if (!Number.isFinite(current.sizeBytes) || current.sizeBytes < 0 || current.sizeBytes > PLAYER_BYTES) { state.set({ kind: "failed" }); return; }
    state.set({ kind: "loading" });
    const controller = new AbortController();
    let active = true;
    let url = "";
    void load(current.id, { signal: controller.signal, maxBytes: PLAYER_BYTES }).then((blob) => {
      if (!active) return;
      url = URL.createObjectURL(new Blob([blob], { type: current.mimeType }));
      state.set({ kind: "ready", url });
    }).catch(() => { if (active && !controller.signal.aborted) state.set({ kind: "failed" }); });
    return () => { active = false; controller.abort(); if (url) URL.revokeObjectURL(url); };
  });
  return { state, retry: () => retry.update((count) => count + 1) };
}

/** UserVideoAttachment: a 4:3 player with the platform's controls. */
export function VideoAttachment(props: { attachment: () => MessageAttachment; load: AttachmentLoader }) {
  const source = useAttachmentUrl(props.attachment, props.load);
  const failed = signal(false);
  const url = () => { const current = source.state(); return current.kind === "ready" ? current.url : ""; };
  return (
    <View class="overflow-hidden rounded-2xl bg-black" style={{ width: COLLAGE_WIDTH, maxWidth: "100%", aspectRatio: 4 / 3 }} accessibilityLabel={`Video ${props.attachment().name}`}>
      {source.state().kind === "ready" && !failed() ? (
        <Video src={url()} controls paused class="size-full" onError={() => failed.set(true)} accessibilityLabel={props.attachment().name} />
      ) : (
        <View class="flex-1 items-center justify-center gap-1 px-2 py-3">
          <Text class="text-center text-2xs text-[#b3b3b3]">{props.attachment().name}</Text>
          {source.state().kind === "loading" ? null : (
            <View onPress={() => { failed.set(false); source.retry(); }} accessibilityLabel="Retry video" role="button" class="rounded-md px-2 py-1 hover:bg-[#2a2a2a]">
              <Text class="text-xs text-[#b3b3b3]">Video unavailable. Retry</Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

/** InlineAudioPreview, bubble variant: a play button, the name and the clock. The audio itself plays through a 1pt player. */
export function AudioAttachment(props: { attachment: () => MessageAttachment; load: AttachmentLoader }) {
  const source = useAttachmentUrl(props.attachment, props.load);
  const playing = signal(false);
  const position = signal({ time: 0, duration: 0 });
  const failed = signal(false);
  const url = () => { const current = source.state(); return current.kind === "ready" ? current.url : ""; };
  const unavailable = () => failed() || source.state().kind === "failed";
  return (
    <View class="w-64 max-w-full flex-row items-center gap-2 rounded-2xl bg-message-surface py-2 pe-2 ps-2" accessibilityLabel={`Audio ${props.attachment().name}`}>
      <View
        class="size-9 shrink-0 items-center justify-center rounded-full bg-background hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
        disabled={unavailable() || source.state().kind !== "ready"}
        onPress={() => playing.update((value) => !value)}
        accessibilityLabel={playing() ? "Pause audio" : "Play audio"}
        role="button"
      >
        <TimelineIcon name={playing() ? "pause" : "play"} size={14} />
      </View>
      <View class="min-w-0 flex-1">
        <Text class="truncate text-sm font-medium text-message-foreground">{props.attachment().name}</Text>
        <Text class="text-xs tabular-nums text-muted-foreground">{unavailable() ? "Audio unavailable" : `${formatClock(position().time)} / ${formatClock(position().duration)}`}</Text>
      </View>
      {source.state().kind === "ready" && !failed() ? (
        <Video
          src={url()}
          paused={!playing()}
          style={{ width: 1, height: 1 }}
          onLoad={(event) => position.update((current) => ({ ...current, duration: event.duration }))}
          onProgress={(event) => position.set({ time: event.currentTime, duration: event.duration })}
          onEnd={() => { playing.set(false); position.update((current) => ({ ...current, time: 0 })); }}
          onError={() => failed.set(true)}
        />
      ) : null}
    </View>
  );
}
