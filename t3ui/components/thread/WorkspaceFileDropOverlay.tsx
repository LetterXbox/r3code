// TimelineOverlays.tsx WorkspaceFileDropOverlay: a dashed frame over the chat with "Drop files to attach" while files are
// dragged over it.
import { Text, View } from "nsh";
import { ComposerIcon } from "../composer/ComposerIcon";
import { tokenAlpha } from "../composer/tokenColor";

export function WorkspaceFileDropOverlay() {
  return (
    <View class="absolute inset-2 z-40 items-center justify-center rounded-2xl border-2 border-dashed" style={{ borderColor: tokenAlpha("primary", 0.6), backgroundColor: tokenAlpha("primary", 0.035), pointerEvents: "none" }}>
      <View accessibilityLabel="Drop files to attach" class="flex-row items-center gap-2 rounded-full border bg-background px-4 py-2.5 shadow-lg" style={{ borderColor: tokenAlpha("primary", 0.25) }}>
        <ComposerIcon name="paperclip" size={16} />
        <Text class="text-sm font-medium text-foreground">Drop files to attach</Text>
      </View>
    </View>
  );
}
