// components/ConnectionStatusDot.tsx: the size-2 dot of an environment's connection (green connected, amber while connecting or
// reconnecting, red on error, grey otherwise), with the tooltip text as its accessible label.
import { View } from "nsh";
import { connectionPhaseDotClassName, connectionPhaseDotOpacity, connectionPhasePings, type ConnectionPhase } from "./connection.logic";
import { MotionLoop } from "../motion/Motion";
import { statusPing } from "../motion/motionTokens";

export function ConnectionStatusDot(props: { phase: () => ConnectionPhase; tooltipText?: () => string | null }) {
  return (
    <View
      class="size-3 shrink-0 items-center justify-center"
      accessibilityLabel={props.tooltipText?.() ?? undefined}
      tooltip={props.tooltipText?.() ?? undefined}
    >
      {/* ConnectionStatusDot.tsx:38-43: a bg-warning/60 motion-safe:animate-status-ping ring behind the dot while connecting. */}
      {connectionPhasePings(props.phase()) ? (
        <View class="absolute size-2" style={{ opacity: 0.6 }}><MotionLoop spec={statusPing} class="size-2 rounded-full bg-warning" /></View>
      ) : null}
      <View class={`size-2 rounded-full ${connectionPhaseDotClassName(props.phase())}`} style={{ opacity: connectionPhaseDotOpacity(props.phase()) }} />
    </View>
  );
}
