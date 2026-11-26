import { cleanup, createMotion, effect, platform, reduceMotion, Text, untracked, View } from "nsh";
import type { MotionSpec } from "nsh";
import { isDeclarativeWindow } from "../../../desktop/windowControl";

const BAND = 72;
const STEPS = 30;

export function shimmerCenter(step: number, width: number): number {
  return -BAND / 2 + ((width + BAND) * (step % STEPS)) / STEPS;
}

/** Amount of foreground colour at a character's approximate position. */
export function shimmerStrength(index: number, count: number, step: number, width: number): number {
  if (count <= 0 || width <= 0) return 0;
  const position = ((index + 0.5) / count) * width;
  return Math.max(0, 1 - Math.abs(position - shimmerCenter(step, width)) / (BAND / 2));
}

const shimmerPulse: MotionSpec = {
  keyframes: { opacity: [1, 0.45, 1] },
  duration: 1800,
  easing: "easeInOut",
  iterations: "infinite",
};

export function ShimmerText(props: { text: () => string; active: () => boolean; class?: string; tabular?: boolean }) {
  const motion = createMotion();
  effect(() => {
    const on = props.active() && !reduceMotion();
    untracked(() => {
      if (on) {
        const spec = platform.os === "windows" && isDeclarativeWindow()
          ? ({ ...shimmerPulse, frameRate: 15 } as MotionSpec)
          : shimmerPulse;
        void motion.play(spec);
      } else {
        motion.reset();
      }
    });
  });
  cleanup(() => motion.stop());
  return (
    <View class="min-w-0 shrink" style={motion.style}>
      <Text class={`${props.class ?? ""} truncate text-muted-foreground ${props.tabular ? "tabular-nums" : ""}`} accessibilityLabel={props.active() ? "Working shimmer" : undefined}>
        {props.text()}
      </Text>
    </View>
  );
}
