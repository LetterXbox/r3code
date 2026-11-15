// ProjectFavicon.tsx / ProjectMonogram.tsx: a size-4 slot for the project's mark. A configured
// icon wins (a monogram on its colour, an emoji, a lucide mark), then the workspace's favicon,
// then the monogram the name derives: the first two glyphs in mono bold, rounded-[25%], on a 14%
// tint of the project colour. Colors for the derived tile come from sidebarProjectIdentity.
import { colorScheme, Image, signal, Text, token, View } from "nsh";
import { PROJECT_LUCIDE_ICON_SRC } from "./projectLucideIcons";
import { allProjects } from "../../store";
import { sidebarProjectIdentity } from "../SidebarUtils";
import { Glyph } from "./SidebarGlyph";
import type { GlyphName } from "./SidebarGlyph";
import { mixColors } from "./mix";
import { parseProjectIcon, projectFaviconSrc, projectIconColor } from "./projectIcon";
import type { ProjectIcon } from "./projectIcon";

const SHARED_GLYPHS: ReadonlySet<string> = new Set(["pin", "check", "clock", "hash", "plus", "copy", "pencil", "folder-code"]);

function Monogram(props: { text: string; size: number; foreground: string; background: string }) {
  return (
    <View
      class="items-center justify-center"
      style={{ width: props.size, height: props.size, borderRadius: props.size * 0.25, backgroundColor: props.background }}
    >
      <Text class="font-mono font-bold" style={{ color: props.foreground, fontSize: props.size * 0.5 }}>{props.text}</Text>
    </View>
  );
}

/** The mark itself, for an icon override and a favicon address already resolved. */
export function ProjectMark(props: { name: string; size?: number; icon: ProjectIcon | null; src: string | null }) {
  const size = props.size ?? 16;
  const failed = signal<string | null>(null);
  const identity = () => sidebarProjectIdentity(props.name, colorScheme(), token("sidebar"));
  const derived = () => (
    <Monogram text={identity().label} size={size} foreground={identity().colors[0]} background={identity().colors[1]} />
  );
  const configured = () => {
    const current = props.icon;
    if (!current) return null;
    const scheme = colorScheme();
    if (current.kind === "monogram") {
      const color = projectIconColor(current.color, scheme);
      return <Monogram text={current.text} size={size} foreground={color} background={mixColors(color, token("sidebar"), 0.14)} />;
    }
    if (current.kind === "emoji") {
      return (
        <View class="items-center justify-center" style={{ width: size, height: size }}>
          <Text style={{ fontSize: size * 0.8 }}>{current.emoji}</Text>
        </View>
      );
    }
    const tint = projectIconColor(current.color, scheme);
    const popular = PROJECT_LUCIDE_ICON_SRC[current.name];
    if (popular) return <Image src={popular} style={{ width: size, height: size, tintColor: tint }} />;
    // Marks outside the bundled set read as the web's own fallback, folder-code.
    const name = (SHARED_GLYPHS.has(current.name) ? current.name : "folder-code") as GlyphName;
    return <Glyph name={name} size={size} tint={projectIconColor(current.color, scheme)} />;
  };
  return (
    <View style={{ width: size, height: size }} class="items-center justify-center">
      {props.icon ? configured() : props.src && failed() !== props.src ? (
        <Image
          src={props.src}
          accessibilityLabel={`${props.name} icon`}
          style={{ width: size, height: size, borderRadius: size * 0.25, objectFit: "contain" }}
          onError={() => failed.set(props.src)}
        />
      ) : derived()}
    </View>
  );
}

export function ProjectTile(props: { name: string; size?: number; projectId?: string }) {
  const project = () => (props.projectId ? allProjects().find((item) => item.id === props.projectId) : undefined);
  const icon = () => parseProjectIcon(project()?.projectIcon);
  return <ProjectMark name={props.name} size={props.size} icon={icon()} src={icon() ? null : projectFaviconSrc(project())} />;
}
