// TimelineOverlays.tsx ScrollToEndButton: a glass pill (Button size xs, variant glass) with a down chevron and
// "Scroll to end", centred over the foot of the transcript. The wrapper takes no touches so rows beneath it
// stay reachable; only the pill does.
import { Text, View } from "nsh";
import { Icon } from "../../Icons";

export function ScrollToEndButton(props: { bottomInset?: () => number; summary?: () => string | null; onScrollToEnd: () => void }) {
  return (
    <View class="absolute inset-x-0 bottom-3 items-center py-1.5" style={{ pointerEvents: "box-none", bottom: 12 + (props.bottomInset?.() ?? 0) }}>
      <View
        class="h-6 flex-row items-center justify-center gap-1 rounded-full border border-border-60 bg-background px-[7px] shadow-sm hover:border-border"
        onPress={props.onScrollToEnd}
        accessibilityLabel="Scroll to end"
        role="button"
      >
        <Icon name="chevron-down" size={14} />
        <Text class="text-xs font-medium text-foreground">Scroll to end</Text>
        {props.summary?.() ? <Text class="text-xs font-medium text-muted-foreground">{`· ${props.summary()}`}</Text> : null}
      </View>
    </View>
  );
}
