// Lucide marks the sidebar draws that Icons.tsx (shared) does not carry. Same
// mechanism: an imported SVG painted through <Image> and tinted by token.
import { Image, token } from "nsh";
import arrowLeft from "./icons/arrow-left.svg";
import arrowRight from "./icons/arrow-right.svg";
import alarmClockOff from "./icons/alarm-clock-off.svg";
import alarmClock from "./icons/alarm-clock.svg";
import check from "./icons/check.svg";
import chevronDown from "./icons/chevron-down.svg";
import circleAlert from "./icons/circle-alert.svg";
import circleCheck from "./icons/circle-check.svg";
import circleDashed from "./icons/circle-dashed.svg";
import circleDotDashed from "./icons/circle-dot-dashed.svg";
import ellipsis from "./icons/ellipsis.svg";
import gitMerge from "./icons/git-merge.svg";
import layers from "./icons/layers.svg";
import gitPullRequestClosed from "./icons/git-pull-request-closed.svg";
import gitPullRequestDraft from "./icons/git-pull-request-draft.svg";
import gitPullRequest from "./icons/git-pull-request.svg";
import listFilter from "./icons/list-filter.svg";
import messageCircleQuestion from "./icons/message-circle-question.svg";
import pinOff from "./icons/pin-off.svg";
import pin from "./icons/pin.svg";
import plus from "./icons/plus.svg";
import shieldQuestion from "./icons/shield-question.svg";
import squareTerminal from "./icons/square-terminal.svg";
import triangleAlert from "./icons/triangle-alert.svg";
import downloadIcon from "./icons/download.svg";
import circleArrowUp from "./icons/circle-arrow-up.svg";
import xIcon from "./icons/x.svg";
import timerIcon from "./icons/timer.svg";
import undo2 from "./icons/undo-2.svg";
import userRound from "./icons/user-round.svg";

import clockIcon from "./icons/clock.svg";
import copyIcon from "./icons/copy.svg";
import folder_codeIcon from "./icons/folder-code.svg";
import hashIcon from "./icons/hash.svg";
import mail_openIcon from "./icons/mail-open.svg";
import message_square_plusIcon from "./icons/message-square-plus.svg";
import pencilIcon from "./icons/pencil.svg";
import refresh_cwIcon from "./icons/refresh-cw.svg";
import trash_2Icon from "./icons/trash-2.svg";
import panelLeftClose from "./icons/panel-left-close.svg";
import loaderCircle from "./icons/loader-circle.svg";
import folderGit2 from "./icons/folder-git-2.svg";
import textSearch from "./icons/text-search.svg";
import laptopIcon from "./icons/laptop.svg";
import serverIcon from "./icons/server.svg";
import arrowRightLeft from "./icons/arrow-right-left.svg";

const GLYPHS = {
  "arrow-left": arrowLeft,
  "arrow-right": arrowRight,
  "alarm-clock-off": alarmClockOff,
  "alarm-clock": alarmClock,
  check,
  "chevron-down": chevronDown,
  "circle-alert": circleAlert,
  "circle-check": circleCheck,
  "circle-dashed": circleDashed,
  "circle-dot-dashed": circleDotDashed,
  ellipsis,
  "git-merge": gitMerge,
  layers,
  "git-pull-request-closed": gitPullRequestClosed,
  "git-pull-request-draft": gitPullRequestDraft,
  "git-pull-request": gitPullRequest,
  "list-filter": listFilter,
  "message-circle-question": messageCircleQuestion,
  "pin-off": pinOff,
  pin,
  plus,
  "shield-question": shieldQuestion,
  "square-terminal": squareTerminal,
  timer: timerIcon,
  "triangle-alert": triangleAlert,
  download: downloadIcon,
  "circle-arrow-up": circleArrowUp,
  x: xIcon,
  "undo-2": undo2,
  "user-round": userRound,
  "clock": clockIcon,
  "copy": copyIcon,
  "folder-code": folder_codeIcon,
  "hash": hashIcon,
  "mail-open": mail_openIcon,
  "message-square-plus": message_square_plusIcon,
  "pencil": pencilIcon,
  "refresh-cw": refresh_cwIcon,
  "trash-2": trash_2Icon,
  "loader-circle": loaderCircle,
  "panel-left-close": panelLeftClose,
  "folder-git-2": folderGit2,
  "text-search": textSearch,
  laptop: laptopIcon,
  server: serverIcon,
  "arrow-right-left": arrowRightLeft,
} as const;

export type GlyphName = keyof typeof GLYPHS;

/** One lucide mark at `size`, tinted by a color string (a token() value or hex). */
export function Glyph(props: { name: GlyphName; size?: number; tint?: string }) {
  const size = props.size ?? 12;
  return (
    <Image
      src={GLYPHS[props.name]}
      style={{
        width: size,
        height: size,
        tintColor: props.tint ?? token("sidebar-muted-foreground"),
      }}
    />
  );
}
