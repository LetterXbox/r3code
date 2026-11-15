// Splits chat markdown at its top-level fenced code blocks so each fence can
// be drawn with the reference's header (language label + copy button) while
// everything between fences stays ordinary markdown for TextView.
// Pure and total: any partial (streaming) text yields segments, never throws.

export type MarkdownSegment =
  | { kind: "text"; text: string }
  | {
      kind: "code";
      /** First word of the info string, "" when the fence names none. */
      language: string;
      /** The info string after the language ("title=a.ts", "a.ts"), "" when none. */
      meta: string;
      /** The code without the fences. */
      code: string;
      /** The fence has not closed yet (the reply is still streaming). */
      open: boolean;
      /** The fence as valid markdown, closed if it was open. */
      source: string;
    };

const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export function splitMarkdownFences(markdown: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const text: string[] = [];
  let fence: { marker: string; opener: string; language: string; meta: string; lines: string[] } | null = null;

  const flushText = () => {
    if (text.length === 0) return;
    const joined = text.join("\n");
    text.length = 0;
    if (joined.trim() !== "") segments.push({ kind: "text", text: joined });
  };

  for (const line of markdown.split("\n")) {
    const raw = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(raw);
      if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) {
        const code = fence.lines.join("\n");
        segments.push({
          kind: "code",
          language: fence.language,
          meta: fence.meta,
          code,
          open: false,
          source: `${fence.opener}\n${code}\n${fence.marker}`,
        });
        fence = null;
      } else {
        fence.lines.push(raw);
      }
      continue;
    }
    const open = OPEN_FENCE.exec(raw);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      flushText();
      fence = {
        marker: open[1],
        opener: raw.trim(),
        language: open[2].trim().split(/\s+/)[0] ?? "",
        meta: open[2].trim().split(/\s+/).slice(1).join(" "),
        lines: [],
      };
      continue;
    }
    text.push(raw);
  }
  if (fence) {
    const code = fence.lines.join("\n");
    segments.push({
      kind: "code",
      language: fence.language,
      meta: fence.meta,
      code,
      open: true,
      source: `${fence.opener}\n${code}\n${fence.marker}`,
    });
  } else {
    flushText();
  }
  return segments;
}

/** The label the reference shows over a code block: the fence language, "text" when none. */
export function codeBlockLabel(language: string): string {
  return language.trim() === "" ? "text" : language.trim();
}

/** pierre-icons.ts LANGUAGE_EXTENSION_ALIASES, limited to the extensions fileIcons.ts knows. */
const LANGUAGE_EXTENSION_ALIASES: Record<string, string> = {
  javascript: "js", typescript: "ts", python: "py", ruby: "rb", bash: "sh",
  shell: "sh", shellscript: "sh", zsh: "zsh", yaml: "yml", markdown: "md",
  plaintext: "txt", mdx: "mdx",
};
const LANGUAGE_FILE_NAMES: Record<string, string> = { dockerfile: "Dockerfile" };

/** pierre-icons.ts syntheticFileNameForLanguageId: a synthetic file name whose extension/name picks the code block's language icon. */
export function codeBlockIconFileName(language: string): string {
  const normalized = language.trim().toLowerCase();
  if (normalized === "") return "file.txt";
  return LANGUAGE_FILE_NAMES[normalized] ?? `file.${LANGUAGE_EXTENSION_ALIASES[normalized] ?? normalized}`;
}

const FENCE_TITLE_ATTR = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i;
const FENCE_FILENAME_TOKEN = /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/;

/** MarkdownCodeBlock.logic.ts extractFenceTitle: `title="a.ts"`, `file=a.ts`, or a bare file name in the info string. */
export function extractFenceTitle(meta: string | undefined): string | null {
  if (!meta) return null;
  const attr = FENCE_TITLE_ATTR.exec(meta);
  const title = attr?.[1] ?? attr?.[2] ?? attr?.[3];
  if (title) return title;
  return meta.split(/\s+/).find((candidate) => FENCE_FILENAME_TOKEN.test(candidate)) ?? null;
}

/**
 * Whether a fence offers "Run in terminal" (MarkdownCodeBlock canRun): a shell language, a closed fence that is not
 * streaming, a command that does not end in a line continuation, and no control or invisible format characters
 * (bidi overrides, zero-width) that could make the shown command differ from what the terminal receives.
 */
export function canRunInTerminal(language: string, code: string, open: boolean): boolean {
  const command = code.trim();
  return !open && /^(?:sh|bash|zsh|fish|shell|powershell|pwsh)$/.test(language) && command.length > 0 && !command.endsWith("\\") && !/[\p{Cc}\p{Cf}]/u.test(code.replace(/\r?\n$/, ""));
}
