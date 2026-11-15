// Lucide marks from the web app, drawn as the SVG files in t3ui/icons.
// NSH paints an imported SVG through <Image>. A unicode stand-in is not an icon.
import { Image, View } from "nsh";
import archive from "../icons/archive.svg";
import arrowDown from "../icons/arrow-down.svg";
import arrowLeft from "../icons/arrow-left.svg";
import arrowUp from "../icons/arrow-up.svg";
import bot from "../icons/bot.svg";
import calendarClock from "../icons/calendar-clock.svg";
import chartNoAxesColumn from "../icons/chart-no-axes-column.svg";
import chevronDown from "../icons/chevron-down.svg";
import chevronRight from "../icons/chevron-right.svg";
import fileDiff from "../icons/file-diff.svg";
import eyeOff from "../icons/eye-off.svg";
import flaskConical from "../icons/flask-conical.svg";
import folder from "../icons/folder.svg";
import folderPlus from "../icons/folder-plus.svg";
import plus from "../icons/plus.svg";
import folderTree from "../icons/folder-tree.svg";
import gitBranch from "../icons/git-branch.svg";
import gitPullRequestArrow from "../icons/git-pull-request-arrow.svg";
import globe from "../icons/globe.svg";
import info from "../icons/info.svg";
import keyboard from "../icons/keyboard.svg";
import keyRound from "../icons/key-round.svg";
import lockIcon from "../icons/lock.svg";
import typeIcon from "../icons/type.svg";
import messageSquare from "../icons/message-square.svg";
import messageSquareDashed from "../icons/message-square-dashed.svg";
import messageSquareText from "../icons/message-square-text.svg";
import messagesSquare from "../icons/messages-square.svg";
import mic from "../icons/mic.svg";
import palette from "../icons/palette.svg";
import panelsTopLeft from "../icons/panels-top-left.svg";
import search from "../icons/search.svg";
import server from "../icons/server.svg";
import settings from "../icons/settings.svg";
import settings2 from "../icons/settings-2.svg";
import shieldCheck from "../icons/shield-check.svg";
import smartphone from "../icons/smartphone.svg";
import snapShot from "../icons/snap-shot.svg";
import squarePen from "../icons/square-pen.svg";
import wrench from "../icons/wrench.svg";
import x from "../icons/x.svg";

const ICONS: Record<string, typeof archive> = {
  archive,
  "arrow-down": arrowDown,
  "arrow-left": arrowLeft,
  "arrow-up": arrowUp,
  bot,
  "calendar-clock": calendarClock,
  "chart-no-axes-column": chartNoAxesColumn,
  "chevron-down": chevronDown,
  "chevron-right": chevronRight,
  "file-diff": fileDiff,
  "eye-off": eyeOff,
  "flask-conical": flaskConical,
  folder,
  "folder-plus": folderPlus,
  plus,
  "folder-tree": folderTree,
  "git-branch": gitBranch,
  "git-pull-request-arrow": gitPullRequestArrow,
  globe,
  info,
  keyboard,
  "key-round": keyRound,
  lock: lockIcon,
  type: typeIcon,
  "message-square": messageSquare,
  "message-square-dashed": messageSquareDashed,
  "message-square-text": messageSquareText,
  "messages-square": messagesSquare,
  mic,
  palette,
  "panels-top-left": panelsTopLeft,
  search,
  server,
  settings,
  "settings-2": settings2,
  "shield-check": shieldCheck,
  smartphone,
  "snap-shot": snapShot,
  "square-pen": squarePen,
  wrench,
  x,
};

/** One lucide mark. `name` is the file under t3ui/icons, without .svg. */
export function Icon(props: { name: string; size?: number; tint?: string }) {
  const src = ICONS[props.name];
  const size = props.size ?? 16;
  if (!src) return <View style={{ width: size, height: size }} />;
  return (
    <Image
      src={src}
      fadeDuration={0}
      style={
        props.tint
          ? { width: size, height: size, tintColor: props.tint }
          : { width: size, height: size }
      }
    />
  );
}

/** A chevron that points right when collapsed and down when expanded. */
export function Chevron(props: { collapsed: boolean; class?: string }) {
  return (
    <View
      class={`size-4 items-center justify-center transition-transform duration-150 ease-in-out ${props.class ?? ""}`}
      style={{
        transform: props.collapsed ? "rotate(-90deg)" : "rotate(0deg)",
      }}
    >
      <Icon name="chevron-down" size={14} />
    </View>
  );
}

/**
 * Unused by thread rows. The sidebar paints a trailing status label.
 * The amber branch below is unreachable: `live` already includes awaiting.
 */
export function StatusDot(props: { status: string }) {
  const live = props.status === "running" || props.status === "awaiting";
  return (
    <View
      class={
        live
          ? "size-2 rounded-full bg-primary"
          : props.status === "awaiting"
            ? "size-2 rounded-full bg-[rgb(245,158,11)]"
            : "size-2 rounded-full bg-[rgb(163,163,163)]/40"
      }
    />
  );
}

/** The up arrow in the send button. */
export function SendArrow(props: { on: boolean }) {
  return <Icon name="arrow-up" size={16} tint={props.on ? "#ffffff" : "#a3a3a3"} />;
}

/** Loads every icon's bytes ahead of first use (`Image.prefetch`), so marks do not pop in late. */
export function prefetchIcons(extra: Record<string, unknown> = {}): Promise<void> {
  const sources = [...Object.values(ICONS), ...Object.values(extra)] as (typeof archive)[];
  return Promise.all(sources.map((src) => Image.prefetch(src).catch(() => undefined))).then(() => undefined);
}

/** How many icons `prefetchIcons` loads by default. */
export const ICON_COUNT = Object.keys(ICONS).length;
