// The stash badge and menu above the composer card (chat/ComposerStashBadge.tsx and
// ComposerStashMenu.tsx): a "Stash <count>" shoulder tab on the right, and an attached drawer with
// one row per entry (snippet, age, delete). Up/Down move the highlight, Enter restores it,
// Command-Backspace deletes it and Escape closes the drawer.
import { cleanup, effect, Image, keymap, signal, Scroll, Text, untracked, View } from "nsh";
import { enterStyle } from "../motion/Motion";
import { STASH_PULSE_HOLD_MS, stashCountEnter } from "../motion/motionTokens";
import { formatRelativeTimeLabel } from "../palette/paletteLogic";
import { ComposerIcon } from "./ComposerIcon";
import { moveHighlight } from "./modelPickerLogic";
import { stashEntrySnippet } from "./promptStash";
import type { StashAttachment, StashEntry } from "./promptStash";
import { readAttachment } from "../thread/readAttachment";
import { THUMBNAIL_BYTES } from "../thread/mediaLayout";

const stashThumbUrls = new Map<string, string>();

/** The 16px image thumbnail of a stash row (ComposerStashMenu: size-4 rounded border, object-cover); a bordered blank until the bytes load. */
function StashThumb(props: { attachment: StashAttachment }) {
  const url = signal(stashThumbUrls.get(props.attachment.uploadedId) ?? "");
  effect(() => {
    const attachment = props.attachment;
    if (url() !== "" || attachment.sizeBytes > THUMBNAIL_BYTES) return;
    let active = true;
    const controller = new AbortController();
    const load = attachment.file
      ? Promise.resolve(attachment.file as Blob)
      : readAttachment(attachment.uploadedId, { signal: controller.signal, maxBytes: THUMBNAIL_BYTES });
    void load.then((blob) => {
      if (!active) return;
      const made = URL.createObjectURL(new Blob([blob], { type: attachment.mimeType }));
      stashThumbUrls.set(attachment.uploadedId, made);
      url.set(made);
    }).catch(() => {});
    return () => { active = false; controller.abort(); };
  });
  return (
    <View class="size-4 overflow-hidden rounded border border-border-70 bg-background">
      {url() !== "" ? <Image src={url()} style={{ objectFit: "cover" }} class="size-full" /> : null}
    </View>
  );
}

export function ComposerStashBadge(props: { count: () => number; menuOpen: () => boolean; pulseKey: () => number; onToggle: () => void }) {
  // index.css:229-232,314-330: each stash holds the row at text-foreground and the count at text-primary for 85.7% of
  // 1400ms (the count's step-start jumps back, the row eases back over the rest); the count also rises in, 180ms.
  const pulsing = signal(false);
  let pulseTimer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    if (props.pulseKey() <= 0) return;
    pulsing.set(true);
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => pulsing.set(false), STASH_PULSE_HOLD_MS);
  });
  cleanup(() => clearTimeout(pulseTimer));
  return (
    <View class="flex-row justify-end px-4" accessibilityLabel="Stash">
      <View
        class={`h-6 flex-row items-center gap-1 rounded-t-xl border border-b-0 border-toolbar-border bg-card px-1 ${props.menuOpen() ? "" : "hover:bg-accent-50"}`}
        onPress={props.onToggle}
        accessibilityLabel={`Stashed prompts: ${props.count()}. Open stash.`}
        role="button"
      >
        <View class="w-6 items-center justify-center"><ComposerIcon name="bookmark" size={12} /></View>
        <Text class={`text-xs transition-colors duration-200 ${props.menuOpen() || pulsing() ? "text-foreground" : "text-muted-foreground"}`}>Stash</Text>
        {() => {
          const key = props.pulseKey();
          return <Text class={`pe-1.5 text-xs ${pulsing() ? "text-primary" : "text-muted-foreground"}`} style={key > 0 ? untracked(() => enterStyle(stashCountEnter)) : undefined}>{props.count()}</Text>;
        }}
      </View>
    </View>
  );
}

export function ComposerStashMenu(props: {
  entries: () => StashEntry[];
  shortcutLabel: string | null;
  now: () => number;
  onRestore: (entry: StashEntry) => void;
  onDelete: (entry: StashEntry) => void;
  onClose: () => void;
}) {
  const highlighted = signal<string | null>(props.entries()[0]?.id ?? null);
  const current = () => props.entries().find((entry) => entry.id === highlighted()) ?? props.entries()[0] ?? null;
  const move = (offset: number) => {
    const list = props.entries();
    if (list.length === 0) return;
    const at = list.findIndex((entry) => entry.id === current()?.id);
    highlighted.set(list[moveHighlight(at < 0 ? 0 : at, offset, list.length)]?.id ?? null);
  };
  effect(() => {
    return keymap.bind({
      escape: props.onClose,
      up: () => move(-1),
      down: () => move(1),
      enter: () => { const entry = current(); if (entry) props.onRestore(entry); },
      "mod+backspace": () => { const entry = current(); if (entry) props.onDelete(entry); },
    }, { when: "always", repeat: true });
  });
  return (
    <View class="mx-4 rounded-t-2xl border border-b-0 border-toolbar-border bg-card px-1 py-1.5" accessibilityLabel="Stash">
      <View
        class="min-h-6 flex-row items-center gap-1 rounded-xl hover:bg-accent-50"
        onPress={props.onClose}
        accessibilityLabel="Close stash"
        role="button"
      >
        <View class="w-6 items-center justify-center"><ComposerIcon name="bookmark" size={12} /></View>
        <Text class="min-w-0 flex-1 text-xs text-muted-foreground">Stash</Text>
        <Text class="text-xs text-foreground">{props.entries().length}</Text>
        <View class="w-6 items-center justify-center"><ComposerIcon name="chevron-down" size={12} /></View>
      </View>
      <Scroll class="max-h-72">
        <View class="gap-px" accessibilityLabel="Stashed prompts" role="list">
          {props.entries().length === 0 ? (
            <View class="min-h-6 flex-row items-center gap-1">
              <View class="w-6" />
              <Text class="min-w-0 flex-1 text-xs text-muted-foreground">
                {`Nothing stashed yet.${props.shortcutLabel ? ` Press ${props.shortcutLabel} with a prompt in the composer to stash it.` : ""}`}
              </Text>
            </View>
          ) : (
            <Each of={props.entries()} key={(entry) => entry.id}>
              {(entry) => (
                <View
                  class={`min-h-6 flex-row items-center gap-1 rounded-sm ${current()?.id === entry().id ? "bg-accent" : ""}`}
                  onMouseEnter={() => highlighted.set(entry().id)}
                  accessibilityLabel={`Restore stashed prompt: ${stashEntrySnippet(entry())}`}
                  role="button"
                  onPress={() => props.onRestore(entry())}
                >
                  <View class="w-6 items-center justify-center"><ComposerIcon name="file-text" size={12} /></View>
                  <Text class="min-w-0 flex-1 truncate text-xs text-foreground">{stashEntrySnippet(entry())}</Text>
                  {(entry().attachments ?? []).some((item) => item.kind === "image") ? (
                    <View class="shrink-0 flex-row items-center gap-0.5" accessibilityLabel="Stashed images">
                      <Each of={(entry().attachments ?? []).filter((item) => item.kind === "image").slice(0, 3)} key={(item) => item.id}>
                        {(item) => <StashThumb attachment={item()} />}
                      </Each>
                    </View>
                  ) : null}
                  {(entry().attachments ?? []).filter((item) => item.kind === "file").length > 0 ? (
                    <View class="shrink-0 flex-row items-center gap-1" accessibilityLabel="Stashed files">
                      <ComposerIcon name="file" size={12} />
                      <Text class="text-xs text-muted-foreground">{(entry().attachments ?? []).filter((item) => item.kind === "file").length}</Text>
                    </View>
                  ) : null}
                  <Text class="shrink-0 text-xs text-muted-foreground">{formatRelativeTimeLabel(Date.parse(entry().createdAt), props.now())}</Text>
                  <View
                    class="size-5 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
                    onPress={() => props.onDelete(entry())}
                    accessibilityLabel="Delete stashed prompt"
                    role="button"
                  >
                    <ComposerIcon name="x" size={12} />
                  </View>
                </View>
              )}
            </Each>
          )}
        </View>
      </Scroll>
    </View>
  );
}
