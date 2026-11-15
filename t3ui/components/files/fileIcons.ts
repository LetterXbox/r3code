// Per-type file marks for the tree and tabs (PierreEntryIcon.tsx in the web app). The web draws
// @pierre/trees' sprite tinted by a token; here each token picks a lucide glyph and the web's
// ICON_COLORS tint (light, dark). Pure, so it is tested without an engine.

export type FileGlyph = "file" | "file-code" | "file-text" | "file-terminal" | "file-spreadsheet" | "file-cog" | "file-archive" | "image" | "film" | "database";

/** ICON_COLORS in PierreEntryIcon.tsx, the tokens this port draws: [light, dark]. */
export const ICON_COLORS: Record<string, readonly [string, string]> = {
  default: ["#84848a", "#adadb1"],
  bash: ["#199f43", "#5ecc71"],
  c: ["#1a85d4", "#69b1ff"],
  cpp: ["#1a85d4", "#69b1ff"],
  css: ["#693acf", "#9d6afb"],
  database: ["#a631be", "#d568ea"],
  docker: ["#1a85d4", "#69b1ff"],
  git: ["#ff8c5b", "#d5512f"],
  go: ["#1ca1c7", "#68cdf2"],
  html: ["#d47628", "#ffa359"],
  image: ["#d32a61", "#ff678d"],
  javascript: ["#d5a910", "#ffd452"],
  json: ["#d47628", "#ffa359"],
  markdown: ["#199f43", "#5ecc71"],
  python: ["#1a85d4", "#69b1ff"],
  react: ["#1ca1c7", "#68cdf2"],
  ruby: ["#d52c36", "#ff6762"],
  rust: ["#d47628", "#ffa359"],
  sass: ["#d32a61", "#ff678d"],
  svg: ["#d47628", "#ffa359"],
  swift: ["#d47628", "#ffa359"],
  table: ["#17a5af", "#64d1db"],
  text: ["#84848a", "#adadb1"],
  typescript: ["#1a85d4", "#69b1ff"],
  video: ["#a631be", "#d568ea"],
  vue: ["#199f43", "#5ecc71"],
  yml: ["#d52c36", "#ff6762"],
  zip: ["#d47628", "#ffa359"],
  npm: ["#d52c36", "#ff6762"],
  config: ["#84848a", "#adadb1"],
  // pierre-icons.ts T3_FILE_ICON_SPRITE: the app's own marks over @pierre/trees' set (DOCUMENT_ICON_COLORS and each
  // symbol's light-dark fill/stroke).
  "t3-video": ["#a631be", "#a631be"], "t3-agents": ["#84848a", "#adadb1"], "t3-diff": ["#199f43", "#5ecc71"], "t3-xml": ["#d47628", "#ffa359"],
  "t3-pdf": ["#d52c36", "#ff6762"], "t3-word": ["#1a85d4", "#69b1ff"], "t3-spreadsheet": ["#199f43", "#5ecc71"], "t3-slides": ["#d47628", "#ffa359"],
  "t3-epub": ["#693acf", "#9d6afb"], "t3-csharp": ["#693acf", "#9d6afb"], "t3-dart": ["#1ca1c7", "#68cdf2"], "t3-elixir": ["#a631be", "#d568ea"],
  "t3-haskell": ["#693acf", "#9d6afb"], "t3-java": ["#d47628", "#ffa359"], "t3-kotlin": ["#693acf", "#9d6afb"], "t3-lua": ["#1a85d4", "#69b1ff"],
  "t3-php": ["#693acf", "#9d6afb"], "t3-powershell": ["#1a85d4", "#69b1ff"], "t3-r": ["#1a85d4", "#69b1ff"], "t3-scala": ["#d52c36", "#ff6762"],
  "t3-toml": ["#84848a", "#adadb1"], "t3-pnpm": ["#84848a", "#adadb1"],
};

export interface FileIconSpec { glyph: FileGlyph; token: string }

const BY_EXTENSION: Record<string, FileIconSpec> = {
  ts: { glyph: "file-code", token: "typescript" }, mts: { glyph: "file-code", token: "typescript" }, cts: { glyph: "file-code", token: "typescript" },
  tsx: { glyph: "file-code", token: "react" }, jsx: { glyph: "file-code", token: "react" },
  js: { glyph: "file-code", token: "javascript" }, mjs: { glyph: "file-code", token: "javascript" }, cjs: { glyph: "file-code", token: "javascript" },
  json: { glyph: "file-code", token: "json" }, jsonc: { glyph: "file-code", token: "json" },
  md: { glyph: "file-text", token: "markdown" }, mdx: { glyph: "file-text", token: "markdown" },
  txt: { glyph: "file-text", token: "text" }, log: { glyph: "file-text", token: "text" },
  css: { glyph: "file-code", token: "css" }, scss: { glyph: "file-code", token: "sass" }, sass: { glyph: "file-code", token: "sass" },
  html: { glyph: "file-code", token: "html" }, htm: { glyph: "file-code", token: "html" },
  svg: { glyph: "image", token: "svg" },
  py: { glyph: "file-code", token: "python" }, rb: { glyph: "file-code", token: "ruby" }, go: { glyph: "file-code", token: "go" },
  rs: { glyph: "file-code", token: "rust" }, swift: { glyph: "file-code", token: "swift" },
  c: { glyph: "file-code", token: "c" }, h: { glyph: "file-code", token: "c" }, cpp: { glyph: "file-code", token: "cpp" }, hpp: { glyph: "file-code", token: "cpp" }, cc: { glyph: "file-code", token: "cpp" },
  vue: { glyph: "file-code", token: "vue" },
  sh: { glyph: "file-terminal", token: "bash" }, bash: { glyph: "file-terminal", token: "bash" }, zsh: { glyph: "file-terminal", token: "bash" },
  yml: { glyph: "file-cog", token: "yml" }, yaml: { glyph: "file-cog", token: "yml" }, ini: { glyph: "file-cog", token: "config" },
  png: { glyph: "image", token: "image" }, jpg: { glyph: "image", token: "image" }, jpeg: { glyph: "image", token: "image" }, gif: { glyph: "image", token: "image" }, webp: { glyph: "image", token: "image" }, ico: { glyph: "image", token: "image" },
  zip: { glyph: "file-archive", token: "zip" }, gz: { glyph: "file-archive", token: "zip" }, tar: { glyph: "file-archive", token: "zip" },
  sql: { glyph: "database", token: "database" }, db: { glyph: "database", token: "database" }, sqlite: { glyph: "database", token: "database" },
  // T3_PIERRE_ICONS.byFileExtension: VIDEO_FILE_EXTENSIONS, documents, the language marks, heic/heif as images.
  ...Object.fromEntries(["avi", "m4v", "mkv", "mov", "mp4", "ogv", "webm"].map((ext) => [ext, { glyph: "film", token: "t3-video" } as FileIconSpec])),
  pdf: { glyph: "file-text", token: "t3-pdf" }, doc: { glyph: "file-text", token: "t3-word" }, docx: { glyph: "file-text", token: "t3-word" }, odt: { glyph: "file-text", token: "t3-word" }, rtf: { glyph: "file-text", token: "t3-word" },
  xls: { glyph: "file-spreadsheet", token: "t3-spreadsheet" }, xlsx: { glyph: "file-spreadsheet", token: "t3-spreadsheet" }, ods: { glyph: "file-spreadsheet", token: "t3-spreadsheet" },
  csv: { glyph: "file-spreadsheet", token: "t3-spreadsheet" }, tsv: { glyph: "file-spreadsheet", token: "t3-spreadsheet" },
  ppt: { glyph: "file", token: "t3-slides" }, pptx: { glyph: "file", token: "t3-slides" }, odp: { glyph: "file", token: "t3-slides" }, epub: { glyph: "file-text", token: "t3-epub" },
  cs: { glyph: "file-code", token: "t3-csharp" }, csx: { glyph: "file-code", token: "t3-csharp" }, dart: { glyph: "file-code", token: "t3-dart" },
  diff: { glyph: "file-code", token: "t3-diff" }, patch: { glyph: "file-code", token: "t3-diff" }, ex: { glyph: "file-code", token: "t3-elixir" }, exs: { glyph: "file-code", token: "t3-elixir" },
  hs: { glyph: "file-code", token: "t3-haskell" }, lhs: { glyph: "file-code", token: "t3-haskell" }, heic: { glyph: "image", token: "image" }, heif: { glyph: "image", token: "image" },
  java: { glyph: "file-code", token: "t3-java" }, kt: { glyph: "file-code", token: "t3-kotlin" }, kts: { glyph: "file-code", token: "t3-kotlin" },
  lua: { glyph: "file-code", token: "t3-lua" }, luau: { glyph: "file-code", token: "t3-lua" }, php: { glyph: "file-code", token: "t3-php" },
  ps1: { glyph: "file-terminal", token: "t3-powershell" }, psm1: { glyph: "file-terminal", token: "t3-powershell" }, psd1: { glyph: "file-terminal", token: "t3-powershell" },
  r: { glyph: "file-code", token: "t3-r" }, scala: { glyph: "file-code", token: "t3-scala" }, toml: { glyph: "file-cog", token: "t3-toml" },
  xml: { glyph: "file-code", token: "t3-xml" }, xsd: { glyph: "file-code", token: "t3-xml" }, xsl: { glyph: "file-code", token: "t3-xml" }, xslt: { glyph: "file-code", token: "t3-xml" },
};

const BY_NAME: Record<string, FileIconSpec> = {
  dockerfile: { glyph: "file-cog", token: "docker" },
  ".gitignore": { glyph: "file-cog", token: "git" }, ".gitattributes": { glyph: "file-cog", token: "git" },
  "package.json": { glyph: "file-code", token: "npm" }, "package-lock.json": { glyph: "file-code", token: "npm" },
  "pnpm-lock.yaml": { glyph: "file-cog", token: "t3-pnpm" }, "pnpm-workspace.yaml": { glyph: "file-cog", token: "t3-pnpm" },
  "tsconfig.json": { glyph: "file-code", token: "typescript" }, "agents.md": { glyph: "file-text", token: "t3-agents" },
};

/** The glyph and token for a file name: whole-name matches first, then the extension, else the plain file mark. */
export function resolveFileIcon(path: string): FileIconSpec {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const byName = BY_NAME[name];
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  const byExtension = dot > 0 ? BY_EXTENSION[name.slice(dot + 1)] : undefined;
  return byExtension ?? { glyph: "file", token: "default" };
}

export function fileIconColor(token: string, scheme: "light" | "dark"): string {
  const colors = ICON_COLORS[token] ?? ICON_COLORS.default!;
  return colors[scheme === "light" ? 0 : 1];
}
