import { Image, View } from "nsh";
import { Icon } from "../../Icons";
import brain from "./icons/brain.svg";
import check from "./icons/check.svg";
import circleAlert from "./icons/circle-alert.svg";
import circleCheck from "./icons/circle-check.svg";
import code from "./icons/code.svg";
import eye from "./icons/eye.svg";
import listTodo from "./icons/list-todo.svg";
import pencil from "./icons/pencil.svg";
import terminal from "./icons/terminal.svg";
import laptop from "./icons/laptop.svg";
import zap from "./icons/zap.svg";
import chevronLeft from "./icons/chevron-left.svg";
import chevronUp from "./icons/chevron-up.svg";
import download from "./icons/download.svg";
import ellipsis from "./icons/ellipsis.svg";
import file from "./icons/file.svg";
import hammer from "./icons/hammer.svg";
import messageCircle from "./icons/message-circle.svg";
import shield from "./icons/shield.svg";
import copy from "../copy.svg";
import wrapText from "./icons/wrap-text.svg";
import play from "./icons/play.svg";
import minimize2 from "./icons/minimize-2.svg";
import workflow from "./icons/workflow.svg";
import minus from "./icons/minus.svg";
import externalLink from "./icons/external-link.svg";
import pause from "./icons/pause.svg";
import t3Code from "./icons/t3-code.svg";
import browserApp from "./icons/browser-app.svg";
import link from "./icons/link.svg";
import plus from "../../../icons/plus.svg";
import quote from "./icons/quote.svg";
import packageIcon from "./icons/package.svg";
import sparkles from "./icons/sparkles.svg";
import lightbulb from "./icons/lightbulb.svg";
import octagonAlert from "./icons/octagon-alert.svg";
import messageSquareWarning from "./icons/message-square-warning.svg";
import presentation from "./icons/presentation.svg";
import mail from "./icons/mail.svg";
import maximize2 from "./icons/maximize-2.svg";
import arrowUpRight from "./icons/arrow-up-right.svg";
import zoomIn from "./icons/zoom-in.svg";
import zoomOut from "./icons/zoom-out.svg";
import redo2 from "./icons/redo-2.svg";
import eraserFull from "./icons/eraser-full.svg";
import gitFork from "./icons/git-fork.svg";
import circleStop from "./icons/circle-stop.svg";
import circleDashed from "./icons/circle-dashed.svg";
import circleX from "./icons/circle-x.svg";

const LOCAL: Record<string, typeof brain> = {
  brain, check, "circle-alert": circleAlert, "circle-check": circleCheck, code, copy, eye,
  "list-todo": listTodo, pencil, terminal, laptop, zap, "chevron-left": chevronLeft, "chevron-up": chevronUp, download, ellipsis,
  file, hammer, "message-circle": messageCircle, shield, "wrap-text": wrapText, plus, play, "minimize-2": minimize2, workflow, minus, "external-link": externalLink, pause, "t3-code": t3Code, "browser-app": browserApp, link,
  quote, package: packageIcon, sparkles, lightbulb, "octagon-alert": octagonAlert, "message-square-warning": messageSquareWarning, presentation, mail,
  "maximize-2": maximize2, "arrow-up-right": arrowUpRight, "zoom-in": zoomIn, "zoom-out": zoomOut, "redo-2": redo2, eraser: eraserFull, "git-fork": gitFork, "circle-stop": circleStop,
  "circle-dashed": circleDashed, "circle-x": circleX,
};

/** One lucide mark: this folder's extra marks first, then the shared set in Icons.tsx. */
export function TimelineIcon(props: { name: string; size?: number; tint?: string }) {
  const src = LOCAL[props.name];
  const size = props.size ?? 16;
  if (!src) return <Icon name={props.name} size={size} tint={props.tint} />;
  return (
    <Image src={src} style={props.tint ? { width: size, height: size, tintColor: props.tint } : { width: size, height: size }} />
  );
}

export function IconSlot(props: { name: string; size?: number; tint?: string; class?: string }) {
  return (
    <View class={`size-4 shrink-0 items-center justify-center ${props.class ?? ""}`}>
      <TimelineIcon name={props.name} size={props.size ?? 14} tint={props.tint} />
    </View>
  );
}
