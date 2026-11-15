// The editor brand marks of OpenInPicker.tsx (Icons.tsx, JetBrainsIcons.tsx), as SVG files.
// Cursor, Trae and Zed draw in the text colour, so they come in a dark-mode and a light-mode file.
import { colorScheme, Image } from "nsh";
import { HIcon } from "./HeaderIcons";
import antigravity from "./icons/editors/antigravity.png";
import aqua from "./icons/editors/aqua.svg";
import clion from "./icons/editors/clion.svg";
import cursor from "./icons/editors/cursor.svg";
import cursorLight from "./icons/editors/cursor-light.svg";
import datagrip from "./icons/editors/datagrip.svg";
import dataspell from "./icons/editors/dataspell.svg";
import fileExplorer from "./icons/editors/file-explorer.svg";
import finder from "./icons/editors/finder.svg";
import goland from "./icons/editors/goland.svg";
import idea from "./icons/editors/idea.svg";
import kiro from "./icons/editors/kiro.svg";
import phpstorm from "./icons/editors/phpstorm.svg";
import pycharm from "./icons/editors/pycharm.svg";
import rider from "./icons/editors/rider.svg";
import rubymine from "./icons/editors/rubymine.svg";
import rustrover from "./icons/editors/rustrover.svg";
import trae from "./icons/editors/trae.svg";
import traeLight from "./icons/editors/trae-light.svg";
import vscode from "./icons/editors/vscode.svg";
import vscodeInsiders from "./icons/editors/vscode-insiders.svg";
import vscodium from "./icons/editors/vscodium.svg";
import webstorm from "./icons/editors/webstorm.svg";
import zed from "./icons/editors/zed.svg";
import zedLight from "./icons/editors/zed-light.svg";

const BRAND: Record<string, { dark: typeof cursor; light: typeof cursor }> = {
  "cursor": { dark: cursor, light: cursorLight },
  "trae": { dark: trae, light: traeLight },
  "kiro": { dark: kiro, light: kiro },
  "vscode": { dark: vscode, light: vscode },
  "vscode-insiders": { dark: vscodeInsiders, light: vscodeInsiders },
  "vscodium": { dark: vscodium, light: vscodium },
  "zed": { dark: zed, light: zedLight },
  "antigravity": { dark: antigravity, light: antigravity },
  "idea": { dark: idea, light: idea },
  "aqua": { dark: aqua, light: aqua },
  "clion": { dark: clion, light: clion },
  "datagrip": { dark: datagrip, light: datagrip },
  "dataspell": { dark: dataspell, light: dataspell },
  "goland": { dark: goland, light: goland },
  "phpstorm": { dark: phpstorm, light: phpstorm },
  "pycharm": { dark: pycharm, light: pycharm },
  "rider": { dark: rider, light: rider },
  "rubymine": { dark: rubymine, light: rubymine },
  "rustrover": { dark: rustrover, light: rustrover },
  "webstorm": { dark: webstorm, light: webstorm },
};

/** The mark for an editor id; the file manager is Finder or File Explorer, and a plain folder elsewhere. */
export function EditorIcon(props: { editor: string; os: string; size?: number }) {
  const size = props.size ?? 16;
  const src = () => {
    if (props.editor === "file-manager") return props.os === "macos" || props.os === "ios" ? finder : props.os === "windows" ? fileExplorer : null;
    const entry = BRAND[props.editor];
    return entry ? (colorScheme() === "dark" ? entry.dark : entry.light) : null;
  };
  return src() ? <Image src={src()!} style={{ width: size, height: size }} /> : <HIcon name="folder-closed" size={size} />;
}
