// TraitsSpeed.tsx TraitsSpeedIcon: the bolt (Fast) or the ultrafast mark, filled, at 80% opacity; with a screen reader text
// "Fast mode on" / "Ultrafast mode on". Size "xs" takes the text's own colour; otherwise Claude's tint (#d97757) on its driver.
import { Image, token, View } from "nsh";
import zapFill from "./icons/zap-fill.svg";
import ultrafast from "./icons/ultrafast.svg";

export const speedIconLabel = (speedIcon: "fast" | "ultrafast") => (speedIcon === "ultrafast" ? "Ultrafast mode on" : "Fast mode on");

/** The mark's colour: the surrounding text's at xs, Claude's orange on its driver, else the foreground. */
export const speedIconTint = (driver: string | null | undefined, size: "xs" | "sm"): string => (size === "xs" ? String(token("foreground")) : driver === "claudeAgent" ? "#d97757" : String(token("foreground")));

export function TraitsSpeedIcon(props: { driver?: string | null; speedIcon: "fast" | "ultrafast"; size?: "xs" | "sm" }) {
  const size = () => ((props.size ?? "sm") === "xs" ? 12 : 14);
  return (
    <View class="opacity-80" accessibilityLabel={speedIconLabel(props.speedIcon)} style={{ width: size(), height: size() }}>
      <Image src={props.speedIcon === "ultrafast" ? ultrafast : zapFill} style={{ width: size(), height: size(), tintColor: speedIconTint(props.driver, props.size ?? "sm") }} />
    </View>
  );
}
