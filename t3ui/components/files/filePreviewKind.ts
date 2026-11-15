// Which viewer a file opens in (filePreviewMode.ts and the viewers under files/). Pure, tested without an engine.

export type FilePreviewKind = "image" | "video" | "pdf" | "audio" | "table" | "notebook" | "font" | "office" | "archive" | "sqlite" | "markdown" | "mermaid" | "html" | "text";

const EXTENSIONS: ReadonlyArray<readonly [FilePreviewKind, RegExp]> = [
  ["image", /\.(?:png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i],
  ["pdf", /\.pdf$/i],
  ["video", /\.(?:avi|m4v|mkv|mov|mp4|ogv|webm)$/i],
  ["audio", /\.(?:mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/i],
  ["table", /\.(?:csv|tsv)$/i],
  ["notebook", /\.ipynb$/i],
  ["font", /\.(?:ttf|otf|woff2?)$/i],
  ["office", /\.(?:docx|xlsx|pptx|odt|ods|odp|rtf|epub)$/i],
  // The archives the web app opens (zip, jar, tar, gz, tgz) and its databases; other containers (7z, rar, xz) are binary files.
  ["archive", /\.(?:zip|jar|tar|tgz|gz)$/i],
  ["sqlite", /\.(?:sqlite3?|db)$/i],
  ["markdown", /\.(?:md|mdx|markdown|mdown|mkd)$/i],
  ["mermaid", /\.(?:mmd|mermaid)$/i],
  ["html", /\.html?$/i],
];

export function filePreviewKind(path: string): FilePreviewKind {
  return EXTENSIONS.find(([, pattern]) => pattern.test(path))?.[0] ?? "text";
}

/** Kinds read as text through `projects.readFile`; the others open from the file itself. */
export const readsAsText = (kind: FilePreviewKind): boolean => kind === "text" || kind === "markdown" || kind === "table" || kind === "notebook" || kind === "mermaid" || kind === "html";

/** Kinds a WebView hosts straight from the workspace file's URL. */
export const hostedInWebView = (kind: FilePreviewKind): boolean => kind === "pdf" || kind === "audio" || kind === "font";

/** Kinds the native app parses or plays itself from the file's bytes or URL: archives and databases, office documents, video. */
export const viewedNatively = (kind: FilePreviewKind): boolean => kind === "archive" || kind === "sqlite" || kind === "office" || kind === "video";

/** The kinds with a rendered view and a source view to switch to (the sub-header's eye / code toggle). */
export const hasRenderedMode = (kind: FilePreviewKind): kind is "markdown" | "mermaid" | "html" | "table" => kind === "markdown" || kind === "mermaid" || kind === "html" || kind === "table";

/** renderedToggleLabel (FilePreviewPanel.tsx). */
export function renderedToggleLabel(mode: "markdown" | "mermaid" | "html" | "table", rendered: boolean): string {
  if (mode === "mermaid") return rendered ? "Show Mermaid source" : "Show rendered diagram";
  if (mode === "markdown") return rendered ? "Show markdown source" : "Show rendered markdown";
  if (mode === "table") return rendered ? "Show source" : "Show table";
  return rendered ? "Show HTML source" : "Show rendered page";
}

/** The kinds that offer the word-wrap toggle: raw text. */
export const showsRawText = (kind: FilePreviewKind, rendered: boolean): boolean => kind === "text" || ((kind === "markdown" || kind === "table" || kind === "mermaid" || kind === "html") && !rendered);

/** The copy of a file with no inline viewer (BinaryViewer / OfficeFilePreview's unavailable state). */
export function unsupportedMessage(kind: FilePreviewKind): string {
  if (kind === "office") return "This document can’t be previewed here. Open it in an editor.";
  if (kind === "archive") return "This archive can’t be previewed here. Open it in an editor.";
  return "The file is binary and cannot be displayed as text.";
}

/** The HTML a WebView shows for an audio file (the name is relative to `baseUrl`, the file's folder). */
export function audioPreviewHtml(fileName: string): string {
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:transparent;color-scheme:light dark"><audio controls preload="metadata" src="${encodeURIComponent(fileName)}"></audio></body>`;
}

/** The HTML a WebView shows for a font file: its glyphs at a few sizes. */
export function fontPreviewHtml(fileName: string): string {
  return `<!doctype html><meta charset="utf-8"><style>@font-face{font-family:"preview";src:url("${encodeURIComponent(fileName)}")}body{margin:0;padding:16px;font-family:"preview",sans-serif;color:#888;background:transparent;color-scheme:light dark}p{margin:0 0 12px}</style><body><p style="font-size:48px">Aa Bb Cc 0123</p><p style="font-size:28px">The quick brown fox jumps over the lazy dog</p><p style="font-size:18px">ABCDEFGHIJKLMNOPQRSTUVWXYZ</p><p style="font-size:18px">abcdefghijklmnopqrstuvwxyz</p><p style="font-size:14px">0123456789 !@#$%^&amp;*()[]{}</p></body>`;
}

/** The folder of a workspace file as a `file:` URL with a trailing slash (a WebView's `baseUrl`). */
export function folderFileUrl(cwd: string, relativePath: string): string {
  if (relativePath.startsWith("/")) return `file://${encodeURI(relativePath.slice(0, relativePath.lastIndexOf("/")))}/`;
  const root = cwd.replace(/\/+$/, "");
  const folder = relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : "";
  return `file://${encodeURI(folder ? `${root}/${folder}` : root)}/`;
}
