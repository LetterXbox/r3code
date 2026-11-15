// Lucide marks the pull request pages use, drawn from the SVG files in ./icons.
import { Image, View } from "nsh";
import branchMark from "./icons/branch-mark.svg";
import arrowUpDown from "./icons/arrow-up-down.svg";
import calendarArrowDown from "./icons/calendar-arrow-down.svg";
import calendarArrowUp from "./icons/calendar-arrow-up.svg";
import check from "./icons/check.svg";
import play from "./icons/play.svg";
import unlink from "./icons/unlink.svg";
import gitPullRequest from "./icons/git-pull-request.svg";
import chevronDown from "./icons/chevron-down.svg";
import chevronLeft from "./icons/chevron-left.svg";
import chevronRight from "./icons/chevron-right.svg";
import circleAlert from "./icons/circle-alert.svg";
import circleCheck from "./icons/circle-check.svg";
import circleDashed from "./icons/circle-dashed.svg";
import circleDot from "./icons/circle-dot.svg";
import circleSlash from "./icons/circle-slash.svg";
import circleX from "./icons/circle-x.svg";
import clock from "./icons/clock.svg";
import externalLink from "./icons/external-link.svg";
import eye from "./icons/eye.svg";
import fileDiff from "./icons/file-diff.svg";
import folderGit2 from "./icons/folder-git-2.svg";
import gitBranch from "./icons/git-branch.svg";
import gitMerge from "./icons/git-merge.svg";
import gitPullRequestArrow from "./icons/git-pull-request-arrow.svg";
import gitPullRequestClosed from "./icons/git-pull-request-closed.svg";
import gitPullRequestDraft from "./icons/git-pull-request-draft.svg";
import layers from "./icons/layers.svg";
import listChecks from "./icons/list-checks.svg";
import listFilter from "./icons/list-filter.svg";
import maximize2 from "./icons/maximize-2.svg";
import messageCircle from "./icons/message-circle.svg";
import minimize2 from "./icons/minimize-2.svg";
import penLine from "./icons/pen-line.svg";
import plug2 from "./icons/plug-2.svg";
import plus from "./icons/plus.svg";
import refreshCw from "./icons/refresh-cw.svg";
import search from "./icons/search.svg";
import tag from "./icons/tag.svg";
import triangleAlert from "./icons/triangle-alert.svg";
import pencil from "./icons/pencil.svg";
import userCheck from "./icons/user-check.svg";
import userLock from "./icons/user-lock.svg";
import userPlus from "./icons/user-plus.svg";
import userRound from "./icons/user-round.svg";
import userRoundX from "./icons/user-round-x.svg";
import users from "./icons/users.svg";
import x from "./icons/x.svg";
import arrowLeft from "./icons/arrow-left.svg";
import link from "./icons/link.svg";
import panelRight from "./icons/panel-right.svg";
import gitCommitHorizontal from "./icons/git-commit-horizontal.svg";
import copy from "./icons/copy.svg";
import smilePlus from "./icons/smile-plus.svg";
import trash2 from "./icons/trash-2.svg";
import messageSquare from "./icons/message-square.svg";
import messageSquarePlus from "./icons/message-square-plus.svg";
import circle from "./icons/circle.svg";
import hammer from "./icons/hammer.svg";
import paperclip from "./icons/paperclip.svg";
import send from "./icons/send.svg";
import messageSquareOff from "./icons/message-square-off.svg";
import bookOpen from "./icons/book-open.svg";
import messageCircleQuestion from "./icons/message-circle-question.svg";
import sparkles from "./icons/sparkles.svg";
import rotateCcw from "./icons/rotate-ccw.svg";

const ICONS: Record<string, typeof branchMark> = {
  "arrow-up-down": arrowUpDown,
  "calendar-arrow-down": calendarArrowDown,
  "calendar-arrow-up": calendarArrowUp,
  "check": check,
  "play": play,
  "unlink": unlink,
  "git-pull-request": gitPullRequest,
  "chevron-down": chevronDown,
  "chevron-left": chevronLeft,
  "chevron-right": chevronRight,
  "circle-alert": circleAlert,
  "circle-check": circleCheck,
  "circle-dashed": circleDashed,
  "circle-dot": circleDot,
  "circle-slash": circleSlash,
  "circle-x": circleX,
  "clock": clock,
  "external-link": externalLink,
  "eye": eye,
  "file-diff": fileDiff,
  "folder-git-2": folderGit2,
  "git-branch": gitBranch,
  "git-merge": gitMerge,
  "git-pull-request-arrow": gitPullRequestArrow,
  "git-pull-request-closed": gitPullRequestClosed,
  "git-pull-request-draft": gitPullRequestDraft,
  "layers": layers,
  "list-checks": listChecks,
  "list-filter": listFilter,
  "maximize-2": maximize2,
  "message-circle": messageCircle,
  "minimize-2": minimize2,
  "pen-line": penLine,
  "pencil": pencil,
  "plug-2": plug2,
  "plus": plus,
  "refresh-cw": refreshCw,
  "search": search,
  "tag": tag,
  "triangle-alert": triangleAlert,
  "user-check": userCheck,
  "user-plus": userPlus,
  "user-lock": userLock,
  "user-round": userRound,
  "user-round-x": userRoundX,
  "users": users,
  "x": x,
  "arrow-left": arrowLeft,
  "link": link,
  "panel-right": panelRight,
  "git-commit-horizontal": gitCommitHorizontal,
  "copy": copy,
  "smile-plus": smilePlus,
  "trash-2": trash2,
  "message-square": messageSquare,
  "message-square-plus": messageSquarePlus,
  "circle": circle,
  "hammer": hammer,
  "paperclip": paperclip,
  "send": send,
  "message-square-off": messageSquareOff,
  "book-open": bookOpen,
  "message-circle-question": messageCircleQuestion,
  "sparkles": sparkles,
  "rotate-ccw": rotateCcw,
};

/** One mark. `tint` recolours it; the files carry the muted-foreground stroke. */
export function PRIcon(props: { name: string; size?: number; tint?: string }) {
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

/** The empty-state illustration from PullRequestListEmptyState's BranchMark. */
export function BranchMark() {
  return <Image src={branchMark} style={{ width: 128, height: 77 }} />;
}

