import { signal, Text, View } from "nsh";
import { canUndoDiscardDraft, undoDiscardDraft } from "../store";
import { Presence, presenceStyle } from "./motion/Motion";
import { undoNoticeFadeIn, undoNoticeFadeOut } from "./motion/motionTokens";

export function SidebarDraftUndo() {
  const pending = signal(false);
  const undoFailed = signal(false);
  const undo = async () => {
    if (pending()) return;
    pending.set(true);
    undoFailed.set(false);
    try {
      await undoDiscardDraft();
    } catch {
      undoFailed.set(true);
    } finally {
      pending.set(false);
    }
  };
  // SidebarThreadUndoNotice.tsx:46: fades in and out, opacity 200ms ease-out; inert while it fades out.
  return <Presence when={canUndoDiscardDraft} ms={200}>{(closing) => (
    <View class="min-w-0 flex-1 flex-row items-center justify-end gap-1" style={[presenceStyle(undoNoticeFadeIn, undoNoticeFadeOut, () => !closing()), closing() ? { pointerEvents: "none" } : null]}>
      <Text class={`text-2xs ${undoFailed() ? "text-error-foreground" : "text-sidebar-muted-foreground"}`}>
        {undoFailed() ? "Could not undo." : "Discarded,"}
      </Text>
      <View
        role="button"
        accessibilityLabel="Undo discard draft"
        disabled={pending()}
        onPress={() => { void undo(); }}
        class="h-6 items-center justify-center rounded px-1 hover:bg-sidebar-row-hover"
      >
        <Text class="text-2xs text-sidebar-foreground">Undo</Text>
      </View>
    </View>
  )}</Presence>;
}
