// The lucide marks the banners use (the lucide-react icons the reference's banners import), as SVG through <Image>.
// The source files are #a3a3a3; `tint` recolours the stroke.
import { Image, View } from "nsh";
import circleAlert from "./icons/circle-alert.svg";
import circleDashed from "./icons/circle-dashed.svg";
import circleStop from "./icons/circle-stop.svg";
import download from "./icons/download.svg";
import gauge from "./icons/gauge.svg";
import gitBranch from "./icons/git-branch.svg";
import info from "./icons/info.svg";
import messageCircle from "./icons/message-circle.svg";
import refreshCw from "./icons/refresh-cw.svg";
import shieldQuestion from "./icons/shield-question.svg";
import sparkles from "./icons/sparkles.svg";
import target from "./icons/target.svg";
import terminal from "./icons/terminal.svg";
import triangleAlert from "./icons/triangle-alert.svg";
import wifiOff from "./icons/wifi-off.svg";
import x from "./icons/x.svg";
import eraser from "./icons/eraser.svg";
import building from "../../icons/building.svg";

const ICONS = {
  "circle-alert": circleAlert,
  "circle-dashed": circleDashed,
  "circle-stop": circleStop,
  download,
  eraser,
  building,
  gauge,
  "git-branch": gitBranch,
  info,
  "message-circle": messageCircle,
  "refresh-cw": refreshCw,
  "shield-question": shieldQuestion,
  sparkles,
  target,
  terminal,
  "triangle-alert": triangleAlert,
  "wifi-off": wifiOff,
  x,
};

export type BannerIconName = keyof typeof ICONS;

export function BannerIcon(props: { name: BannerIconName; size?: number; tint?: string }) {
  const src = ICONS[props.name];
  const size = props.size ?? 12;
  if (!src) return <View style={{ width: size, height: size }} />;
  return <Image src={src} style={props.tint ? { width: size, height: size, tintColor: props.tint } : { width: size, height: size }} />;
}
