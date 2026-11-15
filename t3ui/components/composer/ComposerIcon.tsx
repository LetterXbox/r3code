// Lucide marks the composer needs beyond t3ui/components/Icons.tsx (which is shared,
// so these live in the composer's own folder). Same technique: SVG through <Image>.
import { Image, View } from "nsh";
import paperclip from "../thread/paperclip.svg";
import atSign from "./icons/at-sign.svg";
import check from "./icons/check.svg";
import scale from "./icons/scale.svg";
import circleAlert from "./icons/circle-alert.svg";
import cornerUpRight from "./icons/corner-up-right.svg";
import file from "./icons/file.svg";
import folder from "./icons/folder.svg";
import gitBranch from "./icons/git-branch.svg";
import history from "./icons/history.svg";
import layers from "./icons/layers.svg";
import listPlus from "./icons/list-plus.svg";
import listTodo from "./icons/list-todo.svg";
import lock from "./icons/lock.svg";
import penLine from "./icons/pen-line.svg";
import shieldOff from "./icons/shield-off.svg";
import slidersHorizontal from "./icons/sliders-horizontal.svg";
import sparkles from "./icons/sparkles.svg";
import star from "./icons/star.svg";
import starFilled from "./icons/star-filled.svg";
import terminal from "./icons/terminal.svg";
import play from "./icons/play.svg";
import gauge from "./icons/gauge.svg";
import zap from "./icons/zap.svg";
import gitBranchPlus from "./icons/git-branch-plus.svg";
import clock3 from "./icons/clock-3.svg";
import workflow from "./icons/workflow.svg";
import bookmark from "./icons/bookmark.svg";
import fileText from "./icons/file-text.svg";
import mic from "./icons/mic.svg";
import folderGit from "./icons/folder-git.svg";
import folderGit2 from "./icons/folder-git-2.svg";
import gitPullRequest from "./icons/git-pull-request.svg";
import refreshCw from "./icons/refresh-cw.svg";
import trash2 from "./icons/trash-2.svg";
import minimize2 from "./icons/minimize-2.svg";
import eraser from "./icons/eraser.svg";
import userRound from "./icons/user-round.svg";
import blocks from "./icons/blocks.svg";
import settingsIcon from "./icons/settings.svg";
import packageIcon from "./icons/package.svg";
import laptop from "./icons/laptop.svg";
import server from "./icons/server.svg";
import ellipsis from "./icons/ellipsis.svg";
import arrowUp from "../../icons/arrow-up.svg";
import pencil from "../../icons/pencil.svg";
import plus from "../../icons/plus.svg";
import chevronDown from "../../icons/chevron-down.svg";
import chevronUp from "./icons/chevron-up.svg";
import bot from "../../icons/bot.svg";
import search from "../../icons/search.svg";
import x from "../../icons/x.svg";

const ICONS: Record<string, typeof check> = {
  ellipsis,
  laptop,
  server,
  "user-round": userRound,
  blocks,
  settings: settingsIcon,
  package: packageIcon,
  eraser,
  "minimize-2": minimize2,
  "bookmark": bookmark,
  "file-text": fileText,
  "mic": mic,
  "folder-git": folderGit,
  "folder-git-2": folderGit2,
  "git-pull-request": gitPullRequest,
  "refresh-cw": refreshCw,
  "trash-2": trash2,
  "arrow-up": arrowUp,
  "at-sign": atSign,
  bot,
  "clock-3": clock3,
  gauge,
  "git-branch-plus": gitBranchPlus,
  pencil,
  play,
  plus,
  workflow,
  zap,
  check,
  scale,
  "chevron-down": chevronDown,
  "chevron-up": chevronUp,
  "circle-alert": circleAlert,
  "corner-up-right": cornerUpRight,
  file,
  folder,
  "git-branch": gitBranch,
  history,
  layers,
  "list-plus": listPlus,
  "list-todo": listTodo,
  lock,
  paperclip,
  "pen-line": penLine,
  search,
  "shield-off": shieldOff,
  "sliders-horizontal": slidersHorizontal,
  sparkles,
  star,
  "star-filled": starFilled,
  terminal,
  x,
};

export type ComposerIconName = keyof typeof ICONS;

/** One lucide mark. `tint` recolours the stroke (the source files are #a3a3a3). */
export function ComposerIcon(props: { name: string; size?: number; tint?: string }) {
  const src = ICONS[props.name];
  const size = props.size ?? 16;
  if (!src) return <View style={{ width: size, height: size }} />;
  return (
    <Image
      src={src}
      style={props.tint ? { width: size, height: size, tintColor: props.tint } : { width: size, height: size }}
    />
  );
}
