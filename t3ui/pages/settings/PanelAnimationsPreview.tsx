// settings/PanelAnimationsPreview.tsx: a 112 x 40 sketch of the app (sidebar, transcript lines, terminal drawer, right panel) beside the
// "Panel animations" slider. Pressing it opens or closes the three panels using the slider's duration, ease-out, so the setting can be felt.
// The reference animates `width, height, border-width` with CSS; NSH animates no layout property by style, so the toggle runs through
// `LayoutAnimation.configureNext` (the resized views' frames ease to their new size). Skipped at 0 ms and with reduced motion
// (`motion-reduce:transition-none`). Whether the frames really ease in the window needs eyes on the real window.
import { LayoutAnimation, reduceMotion, signal, View } from "nsh";
import { tokenAlpha } from "../../components/composer/tokenColor";

/** Animates the next commit's frame changes for `durationMs` ease-out; nothing at 0 ms or with reduced motion. */
export function animateNextLayout(durationMs: number): boolean {
  if (durationMs <= 0 || reduceMotion()) return false;
  LayoutAnimation.configureNext({ duration: durationMs, update: { type: "easeOut", duration: durationMs } });
  return true;
}

export function PanelAnimationsPreview(props: { durationMs: () => number }) {
  const panelsOpen = signal(true);
  const toggle = () => {
    animateNextLayout(props.durationMs());
    panelsOpen.set(!panelsOpen());
  };
  return (
    <View
      role="button"
      accessibilityLabel="Replay panel animation preview"
      onPress={toggle}
      class="h-10 w-28 flex-row overflow-hidden rounded-lg border border-border bg-background p-1"
      testID="Panel animation preview"
    >
      <View class="h-full shrink-0 overflow-hidden rounded-md bg-sidebar" style={{ width: panelsOpen() ? 16 : 0 }} testID="Preview sidebar" />
      <View class="min-w-0 flex-1 px-1">
        <View class="min-h-0 flex-1 gap-1 pt-1">
          <View class="h-0.5 w-full rounded-full" style={{ backgroundColor: tokenAlpha("muted-foreground", 0.25) }} />
          <View class="h-0.5 rounded-full" style={{ width: "80%", backgroundColor: tokenAlpha("muted-foreground", 0.2) }} />
          <View class="h-0.5 rounded-full" style={{ width: "60%", backgroundColor: tokenAlpha("muted-foreground", 0.15) }} />
        </View>
        <View
          class="shrink-0 flex-row items-center overflow-hidden px-2"
          style={{ height: panelsOpen() ? 8 : 0, borderTopWidth: panelsOpen() ? 1 : 0, borderTopColor: tokenAlpha("border", 0.7), backgroundColor: tokenAlpha("foreground", 0.05) }}
          testID="Preview drawer"
        >
          <View class="h-px rounded-full" style={{ width: "66%", backgroundColor: tokenAlpha("muted-foreground", 0.25) }} />
        </View>
      </View>
      <View class="h-full shrink-0 overflow-hidden rounded-md bg-muted" style={{ width: panelsOpen() ? 20 : 0 }} testID="Preview right panel" />
    </View>
  );
}
