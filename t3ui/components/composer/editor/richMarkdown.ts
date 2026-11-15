// composer-rich-text.ts, composer-code-languages.ts and the fence parsers of composer-rich-text-doc.ts, ported as is:
// the Markdown the rich composer reads its marks (bold, italic, strike, code) and code blocks from.
export type RichTextMark = "bold" | "italic" | "strike" | "code";

interface RichTextSpan {
  text: string;
  marks: RichTextMark[];
}

export const RICH_TEXT_DELIMITERS: Record<RichTextMark, string> = {
  bold: "**",
  italic: "*",
  strike: "~~",
  code: "`",
};

/** A run of `text` from `start` to `end` that parses with `marks`. */
interface SourcePiece {
  start: number;
  end: number;
  marks: RichTextMark[];
}

function sameMarks(left: readonly RichTextMark[], right: readonly RichTextMark[]): boolean {
  return left.length === right.length && left.every((mark, index) => mark === right[index]);
}

// Pieces keep source offsets, so callers can map parsed text back onto the
// characters it came from; parsing only drops delimiters.
export function parseInlineMarkdownPieces(text: string): SourcePiece[] {
  const root: SourcePiece[] = [];
  const stack: { delimiter: string; mark: RichTextMark; start: number; pieces: SourcePiece[] }[] =
    [];
  const push = (start: number, end: number, marks: RichTextMark[] = []) => {
    if (end <= start) return;
    const pieces = stack.at(-1)?.pieces ?? root;
    const last = pieces.at(-1);
    if (last?.end === start && sameMarks(last.marks, marks)) last.end = end;
    else pieces.push({ start, end, marks });
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\\") {
      push(index, Math.min(index + 2, text.length));
      index += 2;
      continue;
    }
    if (char === "`") {
      const run = text.slice(index).match(/^`+/)![0];
      const close = text.indexOf(run, index + run.length);
      if (
        run.length === 1 &&
        close > index + 1 &&
        !text.slice(index, close).includes("\n") &&
        text[close + 1] !== "`"
      ) {
        push(index + 1, close, ["code"]);
        index = close + 1;
      } else {
        push(index, index + run.length);
        index += run.length;
      }
      continue;
    }
    if (char !== "*" && char !== "_" && char !== "~") {
      push(index, index + 1);
      index += 1;
      continue;
    }
    let end = index;
    while (text[end] === char) end += 1;
    const before = text[index - 1] ?? "";
    const after = text[end] ?? "";
    const canClose = before !== "" && !/\s/.test(before) && (char !== "_" || !/\w/.test(after));
    const canOpen = after !== "" && !/\s/.test(after) && (char !== "_" || !/\w/.test(before));
    while (index < end) {
      const top = stack.at(-1);
      const opensNestedBold =
        top?.mark === "italic" &&
        end - index === 2 &&
        canOpen &&
        (char === "*" || char === "_") &&
        !stack.some((frame) => frame.mark === "bold");
      if (
        !opensNestedBold &&
        canClose &&
        top &&
        text.startsWith(top.delimiter, index) &&
        index + top.delimiter.length <= end
      ) {
        stack.pop();
        for (const piece of top.pieces) push(piece.start, piece.end, [top.mark, ...piece.marks]);
        index += top.delimiter.length;
      } else if (canOpen && (char !== "~" || end - index >= 2)) {
        const length = char === "~" || end - index >= 2 ? 2 : 1;
        const mark = char === "~" ? "strike" : length === 2 ? "bold" : "italic";
        // Prevent self-nesting, including alternate delimiters, to bound the stack by supported styles.
        if (stack.some((frame) => frame.mark === mark)) {
          push(index, end);
          index = end;
          continue;
        }
        stack.push({ delimiter: char.repeat(length), mark, start: index, pieces: [] });
        index += length;
      } else {
        push(index, end);
        index = end;
      }
    }
  }
  while (stack.length > 0) {
    const frame = stack.pop()!;
    push(frame.start, frame.start + frame.delimiter.length);
    for (const piece of frame.pieces) push(piece.start, piece.end, piece.marks);
  }
  return root;
}

export function parseInlineMarkdown(text: string): RichTextSpan[] {
  const spans: RichTextSpan[] = [];
  for (const { start, end, marks } of parseInlineMarkdownPieces(text)) {
    const last = spans.at(-1);
    if (last && sameMarks(last.marks, marks)) {
      last.text += text.slice(start, end);
    } else {
      spans.push({ text: text.slice(start, end), marks });
    }
  }
  return spans;
}

/** Marks text the composer shows as editable Markdown source while the caret is in it. */
export const MARKDOWN_SOURCE_MARK = "markdownSource";

/** Marks for each UTF-16 unit of `text`, or null for a delimiter that parsing drops. */
export function inlineMarkdownUnitMarks(text: string): Array<RichTextMark[] | null> {
  const result: Array<RichTextMark[] | null> = Array.from({ length: text.length }, () => null);
  for (const { start, end, marks } of parseInlineMarkdownPieces(text)) {
    result.fill(marks, start, end);
  }
  return result;
}

// composer-rich-text-doc.ts
export function parseOpeningFence(line: string): { fence: string; language: string } | null {
  // Unlike `.`, `[^\n]` accepts the stored \r in CRLF lines.
  const match = /^(`{3,}|~{3,})([^\n]*)$/.exec(line);
  if (!match) return null;
  const fence = match[1]!;
  const language = match[2]!;
  if (fence.startsWith("`") && language.includes("`")) return null;
  return { fence, language };
}

export function isClosingFence(line: string, fence: string): boolean {
  const match = /^(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
  if (!match) return false;
  const run = match[1]!;
  return run[0] === fence[0] && run.length >= fence.length;
}


// composer-code-languages.ts
export const CODE_BLOCK_LANGUAGES = [
  { id: "", label: "Plain text" },
  { id: "asm", label: "Assembly" },
  { id: "bash", label: "Bash" },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
  { id: "csharp", label: "C#" },
  { id: "css", label: "CSS" },
  { id: "dart", label: "Dart" },
  { id: "diff", label: "Diff" },
  { id: "dockerfile", label: "Dockerfile" },
  { id: "elixir", label: "Elixir" },
  { id: "go", label: "Go" },
  { id: "graphql", label: "GraphQL" },
  { id: "haskell", label: "Haskell" },
  { id: "html", label: "HTML" },
  { id: "java", label: "Java" },
  { id: "javascript", label: "JavaScript" },
  { id: "json", label: "JSON" },
  { id: "jsx", label: "JSX" },
  { id: "kotlin", label: "Kotlin" },
  { id: "lua", label: "Lua" },
  { id: "markdown", label: "Markdown" },
  { id: "php", label: "PHP" },
  { id: "powershell", label: "PowerShell" },
  { id: "python", label: "Python" },
  { id: "r", label: "R" },
  { id: "ruby", label: "Ruby" },
  { id: "rust", label: "Rust" },
  { id: "scala", label: "Scala" },
  { id: "scss", label: "SCSS" },
  { id: "sql", label: "SQL" },
  { id: "svelte", label: "Svelte" },
  { id: "swift", label: "Swift" },
  { id: "toml", label: "TOML" },
  { id: "tsx", label: "TSX" },
  { id: "typescript", label: "TypeScript" },
  { id: "vue", label: "Vue" },
  { id: "xml", label: "XML" },
  { id: "yaml", label: "YAML" },
  { id: "zig", label: "Zig" },
] as const;

export type CodeBlockLanguage = { readonly id: string; readonly label: string };

const LANGUAGE_ALIASES: Record<string, string> = {
  assembly: "asm",
  cs: "csharp",
  "c++": "cpp",
  js: "javascript",
  md: "markdown",
  plaintext: "",
  py: "python",
  rb: "ruby",
  rs: "rust",
  s: "asm",
  sh: "bash",
  shell: "bash",
  text: "",
  ts: "typescript",
  txt: "",
  yml: "yaml",
};

export function languageOfInfoString(info: string): string {
  return info.trim().split(/\s+/, 1)[0] ?? "";
}

/** Plain text clears the language unless trailing metadata would be parsed as one. */
export function withInfoStringLanguage(info: string, language: string): string {
  const leading = /^\s*/.exec(info)![0];
  const rest = info.slice(leading.length + languageOfInfoString(info).length);
  if (language) return `${leading}${language}${rest}`;
  return rest.trim() ? `${leading}text${rest}` : "";
}

export function codeLanguageEntry(language: string): CodeBlockLanguage | null {
  const id = LANGUAGE_ALIASES[language.toLowerCase()] ?? language;
  return CODE_BLOCK_LANGUAGES.find((entry) => entry.id === id.toLowerCase()) ?? null;
}

export function codeLanguageLabel(language: string): string {
  return codeLanguageEntry(language)?.label ?? language;
}
