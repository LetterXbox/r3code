// Lucide marks Settings > Voice draws (VoiceSettingsPanel.tsx imports them from lucide-react), as SVG files
// painted through <Image> and tinted with a theme token.
import { Image, token } from "nsh";
import audioLines from "./icons/audio-lines.svg";
import languages from "./icons/languages.svg";
import micOff from "./icons/mic-off.svg";
import pause from "./icons/pause.svg";
import play from "./icons/play.svg";
import slidersHorizontal from "./icons/sliders-horizontal.svg";
import mic from "../../../icons/mic.svg";
import keyRound from "../../../icons/key-round.svg";
import monitor from "../../../icons/monitor.svg";
import check from "../providers/icons/check.svg";
import download from "../providers/icons/download.svg";
import refreshCw from "../providers/icons/refresh-cw.svg";
import rotateCcw from "../providers/icons/rotate-ccw.svg";
import star from "../providers/icons/star.svg";
import trash2 from "../providers/icons/trash-2.svg";
import x from "../providers/icons/x.svg";

const ICONS = {
  "audio-lines": audioLines, languages, "mic-off": micOff, pause, play, "sliders-horizontal": slidersHorizontal,
  mic, "key-round": keyRound, monitor, check, download, "refresh-cw": refreshCw, "rotate-ccw": rotateCcw, star, "trash-2": trash2, x,
};
export type VoiceIconName = keyof typeof ICONS;

export type VoiceIconTone = "foreground" | "muted-foreground" | "primary-foreground" | "icon-muted";

export function VoiceIcon(props: { name: VoiceIconName; size?: number; tone?: VoiceIconTone }) {
  const size = props.size ?? 14;
  return <Image src={ICONS[props.name]} style={{ width: size, height: size, tintColor: token(props.tone ?? "foreground") as string }} />;
}
