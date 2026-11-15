// ui/spinner.tsx: a Loader2 mark turning forever (animate-spin).
import { createMotion, View } from "nsh";
import { Glyph } from "./SidebarGlyph";

export function Spinner(props: { size?: number; tint?: string }) {
  const motion = createMotion();
  void motion.play("spin");
  const size = props.size ?? 14;
  return (
    <View accessibilityLabel="Loading" style={{ ...motion.style, width: size, height: size }}>
      <Glyph name="loader-circle" size={size} tint={props.tint} />
    </View>
  );
}
