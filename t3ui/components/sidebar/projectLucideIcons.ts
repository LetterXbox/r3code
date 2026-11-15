// projectIconOptions.ts POPULAR_PROJECT_ICONS: the 24 Lucide marks the project icon picker offers, bundled
// as assets (lucide-static 1.55, stroke recoloured by tintColor like every other glyph).
import type { ImageAsset } from "nsh";
import i_folder_code from "./icons/project/folder-code.svg";
import i_code_2 from "./icons/project/code-2.svg";
import i_terminal from "./icons/project/terminal.svg";
import i_globe_2 from "./icons/project/globe-2.svg";
import i_server from "./icons/project/server.svg";
import i_database from "./icons/project/database.svg";
import i_bot from "./icons/project/bot.svg";
import i_sparkles from "./icons/project/sparkles.svg";
import i_smartphone from "./icons/project/smartphone.svg";
import i_monitor from "./icons/project/monitor.svg";
import i_cloud_cog from "./icons/project/cloud-cog.svg";
import i_package from "./icons/project/package.svg";
import i_book_open from "./icons/project/book-open.svg";
import i_flask_conical from "./icons/project/flask-conical.svg";
import i_shield_check from "./icons/project/shield-check.svg";
import i_rocket from "./icons/project/rocket.svg";
import i_gamepad_2 from "./icons/project/gamepad-2.svg";
import i_music from "./icons/project/music.svg";
import i_image from "./icons/project/image.svg";
import i_shopping_bag from "./icons/project/shopping-bag.svg";
import i_git_branch from "./icons/project/git-branch.svg";
import i_workflow from "./icons/project/workflow.svg";
import i_wrench from "./icons/project/wrench.svg";
import i_layers_3 from "./icons/project/layers-3.svg";

export const POPULAR_PROJECT_ICONS: readonly string[] = [
  "folder-code",
  "code-2",
  "terminal",
  "globe-2",
  "server",
  "database",
  "bot",
  "sparkles",
  "smartphone",
  "monitor",
  "cloud-cog",
  "package",
  "book-open",
  "flask-conical",
  "shield-check",
  "rocket",
  "gamepad-2",
  "music",
  "image",
  "shopping-bag",
  "git-branch",
  "workflow",
  "wrench",
  "layers-3",
];

export const PROJECT_LUCIDE_ICON_SRC: Readonly<Record<string, ImageAsset>> = {
  "folder-code": i_folder_code,
  "code-2": i_code_2,
  "terminal": i_terminal,
  "globe-2": i_globe_2,
  "server": i_server,
  "database": i_database,
  "bot": i_bot,
  "sparkles": i_sparkles,
  "smartphone": i_smartphone,
  "monitor": i_monitor,
  "cloud-cog": i_cloud_cog,
  "package": i_package,
  "book-open": i_book_open,
  "flask-conical": i_flask_conical,
  "shield-check": i_shield_check,
  "rocket": i_rocket,
  "gamepad-2": i_gamepad_2,
  "music": i_music,
  "image": i_image,
  "shopping-bag": i_shopping_bag,
  "git-branch": i_git_branch,
  "workflow": i_workflow,
  "wrench": i_wrench,
  "layers-3": i_layers_3,
};
