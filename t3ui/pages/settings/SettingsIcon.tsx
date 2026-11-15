// Lucide marks the settings pages need beyond components/Icons.tsx (which is
// shared and append-only for this port). Same rule: an SVG file under
// t3ui/icons painted through <Image>.
import { Image, View } from "nsh";
import { Icon } from "../../components/Icons";
import android from "../../icons/android.svg";
import apple from "../../icons/apple.svg";
import check from "../../icons/check.svg";
import chevronsLeftRightEllipsis from "../../icons/chevrons-left-right-ellipsis.svg";
import eyeOff from "../../icons/eye-off.svg";
import eye from "../../icons/eye.svg";
import ellipsis from "../../icons/ellipsis.svg";
import laptop from "../../icons/laptop.svg";
import minus from "../../icons/minus.svg";
import monitor from "../../icons/monitor.svg";
import route from "../../icons/route.svg";
import gripVertical from "../../icons/grip-vertical.svg";
import terminal from "../../icons/terminal.svg";
import chevronLeft from "../../icons/chevron-left.svg";
import externalLink from "../../icons/external-link.svg";
import pencil from "../../icons/pencil.svg";
import plus from "../../icons/plus.svg";
import rotateCcw from "../../icons/rotate-ccw.svg";
import trash2 from "../../icons/trash-2.svg";
import undo2 from "../../icons/undo-2.svg";
import layers from "../../icons/layers.svg";
import copy from "../../icons/copy.svg";
import play from "../../icons/play.svg";
import inbox from "../../icons/inbox.svg";
import circleX from "../../icons/circle-x.svg";
import fileJson from "../../icons/file-json.svg";
import triangleAlert from "../../icons/triangle-alert.svg";
import qrCode from "../../icons/qr-code.svg";
import plug from "../../icons/plug.svg";
import hardDrive from "../../icons/hard-drive.svg";
import arrowRight from "../../icons/arrow-right.svg";

const EXTRA: Record<string, typeof check> = {
  android,
  apple,
  check,
  "chevrons-left-right-ellipsis": chevronsLeftRightEllipsis,
  ellipsis,
  eye,
  "eye-off": eyeOff,
  laptop,
  minus,
  monitor,
  route,
  "grip-vertical": gripVertical,
  terminal,
  "chevron-left": chevronLeft,
  "external-link": externalLink,
  pencil,
  plus,
  "rotate-ccw": rotateCcw,
  "trash-2": trash2,
  "undo-2": undo2,
  layers,
  copy,
  play,
  inbox,
  "circle-x": circleX,
  "file-json": fileJson,
  "triangle-alert": triangleAlert,
  "qr-code": qrCode,
  plug,
  "hard-drive": hardDrive,
  "arrow-right": arrowRight,
};

export function SettingsIcon(props: { name: string; size?: number; tint?: string }) {
  const size = props.size ?? 16;
  const src = EXTRA[props.name];
  if (!src) return <Icon name={props.name} size={size} {...(props.tint ? { tint: props.tint } : {})} />;
  return <Image src={src} style={props.tint ? { width: size, height: size, tintColor: props.tint } : { width: size, height: size }} />;
}

export function IconSlot(props: { children: any }) {
  return <View class="size-5 items-center justify-center">{props.children}</View>;
}
