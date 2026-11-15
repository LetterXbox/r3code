// QuitHoldOverlay.tsx: the pill at 22% of the window height while the quit shortcut waits for its confirmation.
import { Text, View } from "nsh";
import { quitHint, quitHintMessage } from "./quitHold";

export function QuitHoldOverlay() {
  return (
    <View style={{ pointerEvents: "none" }} class="absolute inset-x-0 top-[22%] z-50 items-center">
      {quitHint() !== null ? (
        <View role="alert" accessibilityLabel="Quit hint" class="rounded-full bg-foreground px-8 py-4 shadow-xl">
          <Text class="text-2xl font-bold text-background">{quitHintMessage(quitHint()!)}</Text>
        </View>
      ) : null}
    </View>
  );
}
