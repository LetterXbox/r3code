// Shown while `/clear` is armed (chat/ComposerFreshSession.tsx); dismissing it keeps the current session.
import { Text, View } from "nsh";
import { ComposerIcon } from "./ComposerIcon";
import { enterStyle } from "../motion/Motion";
import { fadeInStart } from "../motion/motionTokens";

export function FreshSessionBanner(props: { onUndo: () => void }) {
  return (
    <View class="mb-2 flex-row items-start gap-2 rounded-lg border border-border bg-card px-3 py-2" accessibilityLabel="Fresh session" style={enterStyle(fadeInStart)}>
      <ComposerIcon name="eraser" size={16} />
      <View class="min-w-0 flex-1 gap-0.5">
        <Text class="text-xs font-medium text-foreground">Your next message starts a fresh session</Text>
        <Text class="text-xs text-muted-foreground">The agent won't see earlier messages in this thread.</Text>
      </View>
      <View class="size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out" onPress={props.onUndo} accessibilityLabel="Keep the current session" role="button">
        <ComposerIcon name="x" size={14} />
      </View>
    </View>
  );
}
