// Codex markdown directives (packages/shared codexMarkdownDirectives.ts, codexFileCitations.ts, codexArtifactTemplates.ts).
// Codex writes `:codex-file-citation[...]{path=... line_range_start=...}` and `:codex-followup[label]{prompt="..."}` in text and a
// `::artifact-template{...}` leaf on its own line. The reference reads them with micromark; here a scan over the text, outside
// fenced code and code spans, finds the same three forms and anything else is left exactly as written.
// Pure.

// ---- artifact templates ----

export type CodexArtifactTemplateKind = "document" | "presentation" | "spreadsheet" | "site" | "google-docs" | "google-slides" | "google-sheets" | "image" | "email" | "slack";
const KINDS: readonly string[] = ["document", "presentation", "spreadsheet", "site", "google-docs", "google-slides", "google-sheets", "image", "email", "slack"];
const GALLERY_KINDS: readonly string[] = ["imagegen", "product-design"];

export interface CodexArtifactTemplate {
  artifactKind: CodexArtifactTemplateKind;
  displayName: string;
  galleryKind?: string;
  skillDirectory: string;
  skillName: string;
}

const LABEL_BY_KIND: Record<CodexArtifactTemplateKind, string> = {
  document: "Document template",
  presentation: "Presentation template",
  spreadsheet: "Spreadsheet template",
  site: "Site template",
  "google-docs": "Google Doc template",
  "google-slides": "Google Slides template",
  "google-sheets": "Google Sheet template",
  image: "Image template",
  email: "Email template",
  slack: "Slack template",
};

export const codexArtifactTemplatePresentationLabel = (kind: CodexArtifactTemplateKind): string => LABEL_BY_KIND[kind];

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH = /^(?:\\\\[^\\]+\\[^\\]+|\/\/[^/]+\/[^/]+)/;
const isAbsoluteSkillDirectory = (value: string) => (value.startsWith("/") && !value.startsWith("//")) || WINDOWS_DRIVE_PATH.test(value) || WINDOWS_UNC_PATH.test(value);

type Attributes = Readonly<Record<string, string | null | undefined>>;

export function resolveCodexArtifactTemplate(attributes: Attributes | null | undefined): CodexArtifactTemplate | null {
  const artifactKind = attributes?.artifact_kind;
  const displayNameValue = attributes?.display_name;
  const displayName = typeof displayNameValue === "string" ? displayNameValue.trim() : undefined;
  const galleryKind = attributes?.gallery_kind;
  const skillDirectory = attributes?.skill_directory;
  const skillName = attributes?.skill_name;
  if (
    typeof artifactKind !== "string" || !KINDS.includes(artifactKind) ||
    !displayName ||
    typeof skillDirectory !== "string" || !isAbsoluteSkillDirectory(skillDirectory) ||
    typeof skillName !== "string" || !skillName.startsWith("artifact-template-") ||
    (galleryKind !== undefined && galleryKind !== null && !GALLERY_KINDS.includes(galleryKind))
  ) return null;
  return {
    artifactKind: artifactKind as CodexArtifactTemplateKind,
    displayName,
    ...(typeof galleryKind === "string" ? { galleryKind } : {}),
    skillDirectory,
    skillName,
  };
}

const USE_PROMPT_BY_KIND: Record<CodexArtifactTemplateKind, (skill: string) => string> = {
  document: (skill) => `Create a document using this ${skill} about…`,
  presentation: (skill) => `Create a presentation using the ${skill} template about…`,
  spreadsheet: (skill) => `Create a spreadsheet using this ${skill} about…`,
  site: (skill) => `Create a Site using this ${skill} about…`,
  "google-docs": (skill) => `Create a Google Doc using this ${skill} about…`,
  "google-slides": (skill) => `Create a Google Slides presentation using this ${skill} about…`,
  "google-sheets": (skill) => `Create a Google Sheet using this ${skill} about…`,
  image: (skill) => `Create an image using this ${skill} of…`,
  email: (skill) => `Draft an email using this ${skill} about…`,
  slack: (skill) => `Draft a Slack message using this ${skill} about…`,
};

export const codexArtifactTemplateUsePrompt = (template: CodexArtifactTemplate): string => USE_PROMPT_BY_KIND[template.artifactKind](`$${template.skillName}`);

/** The draft with the template's prompt appended once (a draft that already ends with it is returned unchanged). */
export function appendCodexArtifactTemplateUsePrompt(draft: string, template: CodexArtifactTemplate): string {
  const prompt = codexArtifactTemplateUsePrompt(template);
  const trimmedDraft = draft.trimEnd();
  const promptStart = trimmedDraft.length - prompt.length;
  const alreadyEndsWithPrompt = promptStart >= 0 && trimmedDraft.slice(promptStart) === prompt && (promptStart === 0 || /\s/.test(trimmedDraft[promptStart - 1] ?? ""));
  if (alreadyEndsWithPrompt) return draft;
  const needsLeadingSpace = draft.length > 0 && !/\s$/.test(draft);
  return `${draft}${needsLeadingSpace ? " " : ""}${prompt}`;
}

// ---- file citations ----

export interface CodexFileCitationLink { path: string; href: string; label: string; lineRangeStart?: number }

function positiveInteger(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function citationLabel(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized || "File";
}

const markdownDestinationPath = (path: string) => path.replaceAll("%", "%25").replaceAll("#", "%23").replaceAll("?", "%3F");

export function resolveCodexFileCitationLink(attributes: Attributes | null | undefined): CodexFileCitationLink | null {
  const path = attributes?.path?.trim();
  if (!path) return null;
  const lineRangeStart = positiveInteger(attributes?.line_range_start);
  const destinationPath = markdownDestinationPath(path);
  return {
    path,
    href: lineRangeStart === undefined ? destinationPath : `${destinationPath}#L${lineRangeStart}`,
    label: citationLabel(path),
    ...(lineRangeStart === undefined ? {} : { lineRangeStart }),
  };
}

const markdownLabel = (value: string) => value.replace(/[\\[\]*_`<&]/g, "\\$&");
const markdownDestination = (value: string) => value.replaceAll("\\", "%5C").replaceAll("<", "%3C").replaceAll(">", "%3E").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

export const codexFileCitationMarkdown = (citation: CodexFileCitationLink): string => `[${markdownLabel(citation.label)}](<${markdownDestination(citation.href)}>)`;

// ---- scanning ----

const FILE_CITATION = "codex-file-citation";
const FOLLOW_UP = "codex-followup";
const ARTIFACT_TEMPLATE = "artifact-template";

/** The text with fenced code and code spans overwritten by U+0000, same length, so offsets found in it hold in the original. */
function maskCode(text: string): string {
  let masked = text.replace(/(^|\n) {0,3}(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?(?:\n {0,3}\2[`~]*[ \t]*(?=\n|$)|$)|$)/g, (whole) => whole.replace(/[^\n]/g, "\u0000"));
  masked = masked.replace(/(`+)(?!`)[^\n]*?[^`\n]\1(?!`)|(`+)(?!`)[^\n`]\2(?!`)/g, (whole) => "\u0000".repeat(whole.length));
  return masked;
}

function parseAttributes(inner: string): Record<string, string | null> {
  const attributes: Record<string, string | null> = {};
  for (const match of inner.matchAll(/([^\s=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`}]+)))?/g)) {
    const key = match[1] ?? "";
    if (key.startsWith(".") || key.startsWith("#")) continue;
    attributes[key] = match[2] ?? match[3] ?? match[4] ?? null;
  }
  return attributes;
}

const ATTRS = String.raw`\{((?:[^{}"'\n\u0000]|"[^"\n\u0000]*"|'[^'\n\u0000]*')*)\}`;
const TEXT_DIRECTIVE = new RegExp(String.raw`(?<![:\w])(:(${FILE_CITATION}|${FOLLOW_UP}))(?![\w-])(?:\[([^\[\]\n\u0000]*)\])?(?:${ATTRS})?`, "g");
const LEAF_DIRECTIVE = new RegExp(String.raw`^ {0,3}::${ARTIFACT_TEMPLATE}(?:\[([^\[\]\n\u0000]*)\])?(?:${ATTRS})?[ \t]*$`, "gm");

interface Match { start: number; end: number; markdown?: string; template?: CodexArtifactTemplate; label?: string }

function textDirectives(text: string): Match[] {
  const masked = maskCode(text);
  const found: Match[] = [];
  for (const match of masked.matchAll(TEXT_DIRECTIVE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const name = match[2];
    const label = match[3];
    const attributes = match[4] === undefined ? undefined : parseAttributes(match[4]);
    // A directive that does not carry what it needs is left as the text the author wrote.
    if (name === FILE_CITATION) {
      const citation = resolveCodexFileCitationLink(attributes);
      if (citation) found.push({ start, end, markdown: codexFileCitationMarkdown(citation) });
    } else if (name === FOLLOW_UP && attributes?.prompt?.trim() && label?.trim()) {
      found.push({ start, end, label });
    }
  }
  return found;
}

function templateDirectives(text: string): Match[] {
  const masked = maskCode(text);
  const found: Match[] = [];
  for (const match of masked.matchAll(LEAF_DIRECTIVE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const attributes = match[2] === undefined ? undefined : parseAttributes(match[2]);
    const template = resolveCodexArtifactTemplate(attributes);
    if (template) found.push({ start, end, template });
  }
  return found;
}

function replaceMatches(text: string, matches: Match[], replacement: (match: Match) => string | undefined): string {
  let rendered = text;
  for (const match of [...matches].sort((left, right) => right.start - left.start)) {
    const next = match.label !== undefined ? match.label : replacement(match);
    if (next !== undefined) rendered = rendered.slice(0, match.start) + next + rendered.slice(match.end);
  }
  return rendered;
}

/** Inline directives as the markdown they stand for: a file citation as a link to the file, a follow-up as its label. */
export function renderCodexInlineDirectivesAsMarkdown(markdown: string): string {
  if (!markdown.includes(`:${FILE_CITATION}`) && !markdown.includes(`:${FOLLOW_UP}`)) return markdown;
  return replaceMatches(markdown, textDirectives(markdown), (match) => match.markdown);
}

/** What a copy writes: inline directives as markdown, a template as `Name (Kind template)`. */
export function renderCodexDirectivesForCopy(markdown: string): string {
  if (!markdown.includes(`:${FILE_CITATION}`) && !markdown.includes(`:${FOLLOW_UP}`) && !markdown.includes(`::${ARTIFACT_TEMPLATE}`)) return markdown;
  const matches = [...textDirectives(markdown), ...templateDirectives(markdown)];
  return replaceMatches(markdown, matches, (match) => {
    if (match.markdown !== undefined) return match.markdown;
    if (match.template === undefined) return undefined;
    return `${match.template.displayName} (${codexArtifactTemplatePresentationLabel(match.template.artifactKind)})`;
  });
}

export type CodexArtifactTemplateMarkdownSegment =
  | { kind: "markdown"; markdown: string; sourceOffset: number }
  | { kind: "artifact-template"; sourceOffset: number; template: CodexArtifactTemplate };

/** The text cut at each valid `::artifact-template{...}` line: markdown before, the template, markdown after. */
export function splitCodexArtifactTemplateMarkdown(markdown: string): CodexArtifactTemplateMarkdownSegment[] {
  if (!markdown.includes(`::${ARTIFACT_TEMPLATE}`)) return [{ kind: "markdown", markdown, sourceOffset: 0 }];
  const templates = templateDirectives(markdown).filter((match) => match.template !== undefined).sort((left, right) => left.start - right.start);
  if (templates.length === 0) return [{ kind: "markdown", markdown, sourceOffset: 0 }];
  const segments: CodexArtifactTemplateMarkdownSegment[] = [];
  let cursor = 0;
  for (const match of templates) {
    if (match.start > cursor) segments.push({ kind: "markdown", markdown: markdown.slice(cursor, match.start), sourceOffset: cursor });
    segments.push({ kind: "artifact-template", sourceOffset: match.start, template: match.template! });
    cursor = match.end;
  }
  if (cursor < markdown.length) segments.push({ kind: "markdown", markdown: markdown.slice(cursor), sourceOffset: cursor });
  return segments;
}
