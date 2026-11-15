// The GPUI renderer does not draw maskImage, so animate the text spans themselves.
import { effect, signal, Text, View } from "nsh";
import { tokenOver } from "../../composer/tokenColor";

const BAND = 72;
const STEPS = 30;
const STEP_MS = 73;

export function shimmerCenter(step: number, width: number): number {
  return -BAND / 2 + ((width + BAND) * (step % STEPS)) / STEPS;
}

/** Amount of foreground colour at a character's approximate position. */
export function shimmerStrength(index: number, count: number, step: number, width: number): number {
  if (count <= 0 || width <= 0) return 0;
  const position = ((index + 0.5) / count) * width;
  return Math.max(0, 1 - Math.abs(position - shimmerCenter(step, width)) / (BAND / 2));
}

export function ShimmerText(props: { text: () => string; active: () => boolean; class?: string; tabular?: boolean }) {
  const step = signal(0);
  const width = signal(0);
  effect(() => {
    if (!props.active()) return;
    const timer = setInterval(() => step.update((value) => (value + 1) % STEPS), STEP_MS);
    return () => clearInterval(timer);
  });
  return (
    <View class="min-w-0 shrink" onLayout={(event) => width.set(event.bounds.size.width)}>
      <Text class={`${props.class ?? ""} truncate text-muted-foreground ${props.tabular ? "tabular-nums" : ""}`} accessibilityLabel={props.active() ? "Working shimmer" : undefined}>
        {props.active() ? Array.from(props.text()).map((character, index, chars) => (
          <Text style={{ color: tokenOver("foreground", "muted-foreground", shimmerStrength(index, chars.length, step(), width() || chars.length * 7)) }}>{character}</Text>
        )) : props.text()}
      </Text>
    </View>
  );
}
