// EffortGlyph.tsx: rising bars on whole pixels, filled up to the current level, with the
// remaining bars dimmed. Colour follows the text beside it.
import { View } from "nsh";
import { effortBarHeights } from "./modelTraits";

const GLYPH_HEIGHT = 14;
const BASELINE_INSET = 2;

export function EffortGlyph(props: { count: number; filled: number; muted?: boolean }) {
  const maxBar = GLYPH_HEIGHT - BASELINE_INSET;
  const heights = () => effortBarHeights(props.count, maxBar);
  return (
    <View class="flex-row items-end" style={{ width: 4 * props.count - 2, height: GLYPH_HEIGHT, paddingBottom: BASELINE_INSET }} accessibilityLabel="Effort level">
      <Each of={heights()} key="index">
        {(height, index) => (
          <View
            class={props.muted ? "bg-muted-foreground" : "bg-foreground"}
            style={{ width: 2, height: height(), marginRight: index() === props.count - 1 ? 0 : 2, opacity: index() < props.filled ? 1 : 0.4 }}
          />
        )}
      </Each>
    </View>
  );
}
