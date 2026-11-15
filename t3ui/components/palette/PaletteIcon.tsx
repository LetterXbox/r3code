// Palette icons: the shared lucide set first, then the few the palette adds.
import { Image, token, View } from "nsh";
import { Icon } from "../Icons";
import bug from "./icons/bug.svg";
import check from "./icons/check.svg";
import chevronLeft from "./icons/chevron-left.svg";
import chevronRight from "./icons/chevron-right.svg";
import cornerLeftUp from "./icons/corner-left-up.svg";
import fileSearch from "./icons/file-search.svg";
import folderGit2 from "./icons/folder-git-2.svg";
import gitBranch from "./icons/git-branch.svg";
import link from "./icons/link.svg";
import link2 from "./icons/link-2.svg";
import moon from "./icons/moon.svg";
import monitor from "./icons/monitor.svg";
import palette from "./icons/palette.svg";
import pin from "./icons/pin.svg";
import pinOff from "./icons/pin-off.svg";
import plug from "./icons/plug.svg";
import sun from "./icons/sun.svg";
import textSearch from "./icons/text-search.svg";
import triangleAlert from "./icons/triangle-alert.svg";
import userPlus from "./icons/user-plus.svg";
import sourceAzureDevops from "./icons/source-azure-devops.svg";
import sourceBitbucket from "./icons/source-bitbucket.svg";
import sourceCursorOrigin from "./icons/source-cursor-origin.svg";
import sourceForgejo from "./icons/source-forgejo.svg";
import sourceGitcafe from "./icons/source-gitcafe.svg";
import sourceGithub from "./icons/source-github.svg";
import sourceGitlab from "./icons/source-gitlab.svg";

const OWN: Record<string, typeof check> = {
  bug, check, "chevron-left": chevronLeft, "chevron-right": chevronRight, "corner-left-up": cornerLeftUp, "file-search": fileSearch, "folder-git-2": folderGit2,
  "git-branch": gitBranch, link, "link-2": link2, moon, monitor, palette, pin, "pin-off": pinOff, plug, sun, "text-search": textSearch,
  "triangle-alert": triangleAlert, "user-plus": userPlus,
  // SourceControlIconArtwork: each host's own artwork from its source-control definition.
  "source-azure-devops": sourceAzureDevops, "source-bitbucket": sourceBitbucket, "source-cursor-origin": sourceCursorOrigin, "source-forgejo": sourceForgejo,
  "source-gitcafe": sourceGitcafe, "source-github": sourceGithub, "source-gitlab": sourceGitlab,
};
/** isMonochromeSourceControlIcon: marks drawn in the text colour take it; coloured artwork keeps its own colours. */
const MONOCHROME = new Set(["source-github", "source-cursor-origin"]);

export function PaletteIcon(props: { name: string; size?: number }) {
  const size = props.size ?? 16;
  const own = OWN[props.name];
  if (!own) return <Icon name={props.name} size={size} />;
  const tint = MONOCHROME.has(props.name) ? { tintColor: token("foreground") } : {};
  return <View style={{ width: size, height: size }}><Image src={own} style={{ width: size, height: size, ...tint }} /></View>;
}
