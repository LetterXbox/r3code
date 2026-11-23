// One tree entry's mark (WorkspaceEntryIcon.tsx / PierreEntryIcon.tsx): folders keep the muted
// folder mark; files get the glyph and colour of their type. Everything is read inside the JSX so
// a recycled list row that keeps this element while its path changes shows the new mark.
//
// The reference draws @pierre/trees' built-in sprite (resolvePierreIconForEntry /
// ensurePierreIconSprite in pierre-icons.ts): a solid two-tone badge per language/file type (a
// translucent "bg" shape plus a solid monogram/glyph "fg" mark, e.g. a TS monogram, a React atom,
// a markdown "M"/down-arrow mark), not a plain outline. the icon extractor pulled each
// built-in badge's <symbol> out of the reference's @pierre/trees package (read-only) into a
// standalone SVG per token under ./icons/pierre/*.svg, keeping fill="currentColor" so the existing
// per-token tintColor from fileIconColor() recolours the whole two-tone badge in one tint, exactly
// as the reference's colour tokens already did for the old lucide glyphs.
import { colorScheme, Image, View } from "nsh";
import { HIcon } from "../header/HeaderIcons";
import { fileIconColor, resolveFileIcon } from "./fileIcons";
import pierreBash from "./icons/pierre/bash.svg";
import pierreC from "./icons/pierre/c.svg";
import pierreCpp from "./icons/pierre/cpp.svg";
import pierreCss from "./icons/pierre/css.svg";
import pierreDatabase from "./icons/pierre/database.svg";
import pierreDefault from "./icons/pierre/default.svg";
import pierreDocker from "./icons/pierre/docker.svg";
import pierreGit from "./icons/pierre/git.svg";
import pierreGo from "./icons/pierre/go.svg";
import pierreHtml from "./icons/pierre/html.svg";
import pierreImage from "./icons/pierre/image.svg";
import pierreJavascript from "./icons/pierre/javascript.svg";
import pierreJson from "./icons/pierre/json.svg";
import pierreMarkdown from "./icons/pierre/markdown.svg";
import pierreNpm from "./icons/pierre/npm.svg";
import pierrePython from "./icons/pierre/python.svg";
import pierreReact from "./icons/pierre/react.svg";
import pierreRuby from "./icons/pierre/ruby.svg";
import pierreRust from "./icons/pierre/rust.svg";
import pierreSass from "./icons/pierre/sass.svg";
import pierreSvg from "./icons/pierre/svg.svg";
import pierreSwift from "./icons/pierre/swift.svg";
import pierreTable from "./icons/pierre/table.svg";
import pierreText from "./icons/pierre/text.svg";
import pierreTypescript from "./icons/pierre/typescript.svg";
import pierreVue from "./icons/pierre/vue.svg";
import pierreYml from "./icons/pierre/yml.svg";
import pierreZip from "./icons/pierre/zip.svg";
import t3Agents from "./icons/t3/agents.svg";
import t3Csharp from "./icons/t3/csharp.svg";
import t3Dart from "./icons/t3/dart.svg";
import t3Diff from "./icons/t3/diff.svg";
import t3Elixir from "./icons/t3/elixir.svg";
import t3Epub from "./icons/t3/epub.svg";
import t3Haskell from "./icons/t3/haskell.svg";
import t3Java from "./icons/t3/java.svg";
import t3Kotlin from "./icons/t3/kotlin.svg";
import t3Lua from "./icons/t3/lua.svg";
import t3Pdf from "./icons/t3/pdf.svg";
import t3Php from "./icons/t3/php.svg";
import t3Powershell from "./icons/t3/powershell.svg";
import t3R from "./icons/t3/r.svg";
import t3Scala from "./icons/t3/scala.svg";
import t3Slides from "./icons/t3/slides.svg";
import t3Spreadsheet from "./icons/t3/spreadsheet.svg";
import t3Toml from "./icons/t3/toml.svg";
import t3Video from "./icons/t3/video.svg";
import t3Word from "./icons/t3/word.svg";
import t3Xml from "./icons/t3/xml.svg";
import t3PnpmLight from "./icons/t3/pnpm-light.svg";
import t3PnpmDark from "./icons/t3/pnpm-dark.svg";

/** fileIconColor() token -> badge SVG (the icon extractor's TOKENS table). Tokens with no
 * distinct reference badge ("config", "video") fall back to the generic two-tone file mark. */
const BADGES = {
  default: pierreDefault, config: pierreDefault, video: pierreDefault,
  bash: pierreBash, c: pierreC, cpp: pierreCpp, css: pierreCss, database: pierreDatabase,
  docker: pierreDocker, git: pierreGit, go: pierreGo, html: pierreHtml, image: pierreImage,
  javascript: pierreJavascript, json: pierreJson, markdown: pierreMarkdown, npm: pierreNpm,
  python: pierrePython, react: pierreReact, ruby: pierreRuby, rust: pierreRust, sass: pierreSass,
  svg: pierreSvg, swift: pierreSwift, table: pierreTable, text: pierreText,
  typescript: pierreTypescript, vue: pierreVue, yml: pierreYml, zip: pierreZip,
  // pierre-icons.ts T3_FILE_ICON_SPRITE marks (tools: extracted from the reference sprite, one tintable colour each).
  "t3-agents": t3Agents, "t3-csharp": t3Csharp, "t3-dart": t3Dart, "t3-diff": t3Diff, "t3-elixir": t3Elixir, "t3-epub": t3Epub, "t3-haskell": t3Haskell, "t3-java": t3Java, "t3-kotlin": t3Kotlin, "t3-lua": t3Lua, "t3-pdf": t3Pdf, "t3-php": t3Php, "t3-powershell": t3Powershell, "t3-r": t3R, "t3-scala": t3Scala, "t3-slides": t3Slides, "t3-spreadsheet": t3Spreadsheet, "t3-toml": t3Toml, "t3-video": t3Video, "t3-word": t3Word, "t3-xml": t3Xml,
} as const;

export function FileEntryIcon(props: { path: string; kind: "file" | "directory"; expanded?: boolean; size?: number }) {
  const size = () => props.size ?? 14;
  return (
    <View testID={props.kind === "directory" ? (props.expanded ? "entry-icon:folder-open" : "entry-icon:folder-closed") : `entry-icon:${resolveFileIcon(props.path).token}`}>
      {props.kind === "directory"
        ? <HIcon name={props.expanded ? "folder-open" : "folder-closed"} size={size()} />
        : resolveFileIcon(props.path).token === "t3-pnpm"
        // The pnpm mark is two-tone (its yellow squares stay yellow), so it is drawn untinted per scheme.
        ? <Image src={colorScheme() === "light" ? t3PnpmLight : t3PnpmDark} style={{ width: size(), height: size() }} />
        : <Image
          src={BADGES[resolveFileIcon(props.path).token as keyof typeof BADGES] ?? pierreDefault}
          style={{ width: size(), height: size(), tintColor: fileIconColor(resolveFileIcon(props.path).token, colorScheme()) }}
        />}
    </View>
  );
}
