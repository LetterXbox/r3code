// Lucide marks (0.564, the web app's version) the Device surface and the browser chrome use that the shared sets do not carry.
// Names not here fall through to the header's set (HIcon).
import { Image } from "nsh";
import type { ImageAsset } from "nsh";
import { HIcon } from "../header/HeaderIcons";
import arrowUpRight from "./icons/arrow-up-right.svg";
import box from "./icons/box.svg";
import bug from "./icons/bug.svg";
import camera from "./icons/camera.svg";
import check from "./icons/check.svg";
import chevronDown from "./icons/chevron-down.svg";
import chevronLeft from "./icons/chevron-left.svg";
import circleAlert from "./icons/circle-alert.svg";
import circleStop from "./icons/circle-stop.svg";
import ellipsis from "./icons/ellipsis.svg";
import duoBook from "./icons/duo-book.svg";
import duoClosed from "./icons/duo-closed.svg";
import duoLaptop from "./icons/duo-laptop.svg";
import duoOpen from "./icons/duo-open.svg";
import duoTent from "./icons/duo-tent.svg";
import house from "./icons/house.svg";
import keyboard from "./icons/keyboard.svg";
import link2 from "./icons/link-2.svg";
import loaderCircle from "./icons/loader-circle.svg";
import maximize from "./icons/maximize.svg";
import minus from "./icons/minus.svg";
import moon from "./icons/moon.svg";
import mousePointerClick from "./icons/mouse-pointer-click.svg";
import panelRightOpen from "./icons/panel-right-open.svg";
import pictureInPicture2 from "./icons/picture-in-picture-2.svg";
import play from "./icons/play.svg";
import plus from "./icons/plus.svg";
import power from "./icons/power.svg";
import rotateCcw from "./icons/rotate-ccw.svg";
import previewError from "./icons/preview-error.svg";
import ruler from "./icons/ruler.svg";
import screenRotation from "./icons/screen-rotation.svg";
import slidersHorizontal from "./icons/sliders-horizontal.svg";
import smartphone from "./icons/smartphone.svg";
import square from "./icons/square.svg";
import squareDashedMousePointer from "./icons/square-dashed-mouse-pointer.svg";
import sun from "./icons/sun.svg";
import triangleAlert from "./icons/triangle-alert.svg";
import type from "./icons/type.svg";
import unlink2 from "./icons/unlink-2.svg";
import video from "./icons/video.svg";
import volume2 from "./icons/volume-2.svg";
import volumeOff from "./icons/volume-off.svg";
import x from "./icons/x.svg";

const ICONS: Record<string, ImageAsset> = {
  "arrow-up-right": arrowUpRight,
  "box": box,
  "bug": bug,
  "camera": camera,
  "check": check,
  "chevron-down": chevronDown,
  "chevron-left": chevronLeft,
  "circle-alert": circleAlert,
  "circle-stop": circleStop,
  "ellipsis": ellipsis,
  "house": house,
  "keyboard": keyboard,
  "link-2": link2,
  "loader-circle": loaderCircle,
  "maximize": maximize,
  "minus": minus,
  "moon": moon,
  "mouse-pointer-click": mousePointerClick,
  "panel-right-open": panelRightOpen,
  "picture-in-picture-2": pictureInPicture2,
  "play": play,
  "plus": plus,
  "power": power,
  "preview-error": previewError,
  "rotate-ccw": rotateCcw,
  "screen-rotation": screenRotation,
  "ruler": ruler,
  "sliders-horizontal": slidersHorizontal,
  "smartphone": smartphone,
  "square": square,
  "square-dashed-mouse-pointer": squareDashedMousePointer,
  "sun": sun,
  "triangle-alert": triangleAlert,
  "type": type,
  "unlink-2": unlink2,
  "video": video,
  "volume-2": volume2,
  "volume-off": volumeOff,
  "x": x,
  // DeviceDuoGlyph poses (fold and Duo stance controls).
  "duo-book": duoBook,
  "duo-closed": duoClosed,
  "duo-laptop": duoLaptop,
  "duo-open": duoOpen,
  "duo-tent": duoTent,
};

/** One lucide mark by file name at `size` points; `tint` recolours it. */
export function DIcon(props: { name: string; size?: number; tint?: string }) {
  const size = props.size ?? 16;
  return (
    <>
      {ICONS[props.name] === undefined
        ? <HIcon name={props.name} size={size} {...(props.tint ? { tint: props.tint } : {})} />
        : <Image src={ICONS[props.name]} fadeDuration={0} style={props.tint ? { width: size, height: size, tintColor: props.tint } : { width: size, height: size }} />}
    </>
  );
}
