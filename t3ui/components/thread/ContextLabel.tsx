// ComposerContextLabel.tsx (toolbar mode): the text of a context-strip control. In compact mode (contextStripCompact.ts) it
// collapses to no width and fades out, `transition-opacity duration-180 ease-drawer`; the collapse of the width itself runs
// through LayoutAnimation (the reference animates it with the Web Animations API, 180ms ease-drawer). The label also draws its
// text once off-screen at the 240pt cap, so the strip knows how wide it wants to be even while it is collapsed.
import { cleanup, Text, View } from "nsh";
import { cssEasing } from "../motion/motionTokens";
import { EASE_DRAWER } from "../motion/motionTokens";
import { CONTEXT_LABEL_MAX_WIDTH, contextStripCompactMode, registerContextLabel } from "./contextStripCompact";

/** ComposerContextLabel.tsx:30 `duration-180`. */
export const CONTEXT_LABEL_MS = 180;

export function ContextLabel(props: { text: () => string; style?: Record<string, unknown> }) {
  const entry = registerContextLabel();
  cleanup(entry.remove);
  return (
    <View class="min-w-0 shrink flex-row" testID="Context label">
      <View
        class="min-w-0 shrink overflow-hidden"
        style={{ maxWidth: contextStripCompactMode() ? 0 : CONTEXT_LABEL_MAX_WIDTH }}
        onLayout={(event) => entry.setCurrent(event.bounds.size.width)}
      >
        <Text
          class="truncate text-xs text-muted-foreground transition-opacity"
          style={{ ...props.style, opacity: contextStripCompactMode() ? 0 : 1, transitionDuration: `${CONTEXT_LABEL_MS}ms`, transitionTimingFunction: cssEasing(EASE_DRAWER) }}
        >
          {props.text()}
        </Text>
      </View>
      {/* The width the text wants, up to the cap: a 240pt-wide box the text sizes itself in. Never seen or hit. */}
      <View class="absolute" style={{ width: CONTEXT_LABEL_MAX_WIDTH, left: 0, top: 0, opacity: 0, pointerEvents: "none" }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Text class="self-start text-xs" onLayout={(event) => entry.setNatural(event.bounds.size.width)}>{props.text()}</Text>
      </View>
    </View>
  );
}
