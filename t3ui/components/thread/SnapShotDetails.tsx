// SnapShotAttachmentDetails.tsx: the bar over the bottom of a SnapShot tile (the app's icon or first letter, its name, the
// window's title or "Captured window") and the button beside the name that opens the "Accessibility data" popover.
import { Image, Scroll, signal, Text, View } from "nsh";
import { ComposerIcon } from "../composer/ComposerIcon";
import { createAnchor, Popup } from "../composer/Popover";
import { Presence } from "../motion/Motion";
import { DURATION_DEFAULT_MS } from "../motion/motionTokens";
import {
  snapShotAccessibilityDetails, snapShotAccessibilityNotice, snapShotIncludesAccessibility, snapShotWindowLabel, type SnapShotSource,
} from "../../desktop/snapShotSource";

/** SnapShotContentsButton: an overlay icon button; its popover shows the window's accessibility text or why there is none. */
export function SnapShotContentsButton(props: { source: SnapShotSource }) {
  const open = signal(false);
  const anchor = createAnchor();
  const includes = () => snapShotIncludesAccessibility(props.source);
  const details = () => snapShotAccessibilityDetails(props.source);
  return (
    <>
      <View
        ref={anchor.ref}
        role="button"
        class="size-4 items-center justify-center rounded"
        style={{ backgroundColor: "rgba(255,255,255,0.2)", pointerEvents: "auto" }}
        accessibilityLabel={includes() ? "View accessibility data" : "No accessibility data"}
        tooltip={includes() ? "Accessibility data" : "No accessibility data"}
        onPress={() => open.update((value) => !value)}
      >
        <ComposerIcon name={includes() ? "file-text" : "file"} size={12} tint="#ffffff" />
      </View>
      <Presence when={open} ms={DURATION_DEFAULT_MS}>{(closing) => (
        <Popup animated closing={closing} anchor={anchor.anchor} onClose={() => open.set(false)} placement="top" align="center" class="w-96">
          <View class="gap-2 p-3" accessibilityLabel="Accessibility data">
            <Text class="text-sm font-semibold text-foreground">Accessibility data</Text>
            {details() ? (
              <Scroll class="max-h-64 rounded-md border border-border-60 bg-muted-30">
                <View class="p-2.5">
                  <Text class="font-mono text-2xs leading-4 text-foreground">{details()!.content}</Text>
                </View>
              </Scroll>
            ) : (
              <View class="rounded-md border border-border-60 bg-muted-30 p-2.5">
                <Text class="text-xs leading-4 text-muted-foreground">{snapShotAccessibilityNotice(props.source)}</Text>
              </View>
            )}
          </View>
        </Popup>
      )}</Presence>
    </>
  );
}

/** SnapShotAttachmentDetails: the overlay bar. Only the button takes presses; the rest passes them to the tile. */
export function SnapShotAttachmentDetails(props: { source: SnapShotSource; onCopySnapshot?: () => void }) {
  const source = () => props.source;
  return (
    <View class="absolute inset-x-0 bottom-0 flex-row items-center gap-1.5 px-2.5 pb-2 pt-4" style={{ backgroundColor: "rgba(0,0,0,0.62)", pointerEvents: "none" }} accessibilityLabel={`Captured from ${source().appName}`}>
      {source().appIconDataUrl ? (
        <Image src={source().appIconDataUrl!} accessibilityLabel="" class="size-7 shrink-0 rounded-md" />
      ) : (
        <View class="size-7 shrink-0 items-center justify-center rounded-md" style={{ backgroundColor: "rgba(255,255,255,0.2)" }}>
          <Text class="text-3xs font-medium uppercase text-white">{source().appName.slice(0, 1)}</Text>
        </View>
      )}
      <View class="min-w-0 flex-1">
        <View class="min-w-0 flex-row items-center gap-1.5">
          <Text class="truncate text-2xs font-medium text-white">{source().appName}</Text>
          <SnapShotContentsButton source={source()} />
          {props.onCopySnapshot ? (
            <View
              role="button"
              class="size-4 items-center justify-center rounded"
              style={{ backgroundColor: "rgba(255,255,255,0.2)", pointerEvents: "auto" }}
              accessibilityLabel="Copy snapshot"
              tooltip="Copy snapshot"
              onPress={props.onCopySnapshot}
            >
              <ComposerIcon name="copy" size={11} tint="#ffffff" />
            </View>
          ) : null}
        </View>
        <Text class="truncate text-3xs" style={{ color: "rgba(255,255,255,0.7)" }}>{snapShotWindowLabel(source())}</Text>
      </View>
    </View>
  );
}
