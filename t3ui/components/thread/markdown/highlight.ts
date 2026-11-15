// Standalone, pure syntax highlighter (no nsh imports) shared by chat code blocks,
// diffs and file previews.
//
// API
//   resolveLanguage(info)           -> canonical language id, or null when unsupported.
//                                      Accepts fence info strings ("ts", "TypeScript", "language-rust"),
//                                      extensions ("tsx") and file names ("Dockerfile", "src/main.go").
//   highlightCode(code, language)   -> HighlightToken[][]: one array of tokens per line (split on \n).
//                                      Unsupported or empty languages give plain tokens. Never throws, and
//                                      the concatenated token text of each line equals the source line.
//   highlightLine(line, language)   -> HighlightToken[] for a single line (no multi-line state carried).
//   tokenClass(kind)                -> Tailwind classes (light + dark) that colour a token's Text.
//   SUPPORTED_LANGUAGES             -> canonical ids this module understands.

export type HighlightKind =
  | "plain" | "comment" | "keyword" | "string" | "number" | "function" | "type"
  | "constant" | "property" | "operator" | "punctuation" | "tag" | "attr"
  | "inserted" | "deleted" | "heading";

export interface HighlightToken {
  text: string;
  kind: HighlightKind;
}

type Rule = readonly [pattern: RegExp, kind: HighlightKind];

const words = (list: string) => new RegExp(`\\b(?:${list.split(" ").join("|")})\\b`, "y");
// "m" so `^` anchors at line starts; end-of-input is spelled `(?![\\s\\S])` because `$` would match every line end.
const sticky = (source: string) => new RegExp(source, "ym");

const NUMBER = sticky("\\b(?:0[xX][\\da-fA-F_]+|0[bB][01_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)[a-zA-Z]{0,3}\\b");
const DQ = sticky('"(?:[^"\\\\\\n]|\\\\.)*"?');
const SQ = sticky("'(?:[^'\\\\\\n]|\\\\.)*'?");
const TEMPLATE = sticky("`(?:[^`\\\\]|\\\\[\\s\\S])*`?");
const LINE_SLASH = sticky("//[^\\n]*");
const LINE_HASH = sticky("#[^\\n]*");
const BLOCK = sticky("/\\*[\\s\\S]*?(?:\\*/|(?![\\s\\S]))");
const FUNCTION_CALL = sticky("[A-Za-z_$][\\w$]*(?=\\s*\\()");
const TYPE_NAME = sticky("\\b[A-Z][\\w$]*\\b");
const OPERATOR = sticky("[+\\-*/%=<>!&|^~?:]+");
const PUNCT = sticky("[{}()\\[\\];,.]");

function cLike(keywords: string, constants: string, extra: Rule[] = [], comments: Rule[] = [[LINE_SLASH, "comment"], [BLOCK, "comment"]]): Rule[] {
  return [
    ...comments,
    [DQ, "string"],
    [SQ, "string"],
    ...extra,
    [words(constants), "constant"],
    [words(keywords), "keyword"],
    [NUMBER, "number"],
    [FUNCTION_CALL, "function"],
    [TYPE_NAME, "type"],
    [OPERATOR, "operator"],
    [PUNCT, "punctuation"],
  ];
}

const JS_KEYWORDS = "as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of package private protected public readonly return set static super switch this throw try type typeof var void while with yield declare namespace abstract satisfies keyof infer is";
const JS: Rule[] = cLike(JS_KEYWORDS, "true false null undefined NaN Infinity", [[TEMPLATE, "string"]]);

const RULES: Record<string, Rule[]> = {
  javascript: JS,
  typescript: JS,
  json: [
    [sticky('"(?:[^"\\\\\\n]|\\\\.)*"(?=\\s*:)'), "property"],
    [DQ, "string"],
    [LINE_SLASH, "comment"],
    [BLOCK, "comment"],
    [words("true false null"), "constant"],
    [sticky("-?\\d[\\d.]*(?:[eE][+-]?\\d+)?"), "number"],
    [PUNCT, "punctuation"],
  ],
  bash: [
    [LINE_HASH, "comment"],
    [DQ, "string"],
    [SQ, "string"],
    [sticky("\\$(?:\\{[^}\\n]*\\}|\\([^)\\n]*\\)|[A-Za-z_][\\w]*|[0-9@#?$!*-])"), "constant"],
    [words("if then else elif fi for while until do done case esac in function select time return exit export local readonly declare unset source alias set shift trap eval exec"), "keyword"],
    [sticky("(?<=^|[;&|(]\\s*|\\s)--?[A-Za-z][\\w-]*"), "attr"],
    [NUMBER, "number"],
    [sticky("(?:^|(?<=[;&|(]\\s*))[A-Za-z_./~][\\w./~-]*"), "function"],
    [sticky("[|&;<>=!]+"), "operator"],
    [PUNCT, "punctuation"],
  ],
  python: [
    [sticky('(?:[rRbBfFuU]{0,2})(?:"""[\\s\\S]*?(?:"""|(?![\\s\\S]))|\'\'\'[\\s\\S]*?(?:\'\'\'|(?![\\s\\S])))'), "string"],
    [LINE_HASH, "comment"],
    [sticky('[rRbBfFuU]{0,2}"(?:[^"\\\\\\n]|\\\\.)*"?'), "string"],
    [sticky("[rRbBfFuU]{0,2}'(?:[^'\\\\\\n]|\\\\.)*'?"), "string"],
    [sticky("@[A-Za-z_][\\w.]*"), "function"],
    [words("True False None self cls"), "constant"],
    [words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case"), "keyword"],
    [NUMBER, "number"],
    [FUNCTION_CALL, "function"],
    [TYPE_NAME, "type"],
    [OPERATOR, "operator"],
    [PUNCT, "punctuation"],
  ],
  rust: cLike(
    "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while union",
    "true false None Some Ok Err",
    [[sticky("'[A-Za-z_]\\w*(?!')"), "attr"], [sticky("#!?\\[[^\\]\\n]*\\]"), "attr"], [sticky("r#*\"[\\s\\S]*?(?:\"#*|(?![\\s\\S]))"), "string"], [sticky("\\b[a-z_]\\w*!"), "function"]],
  ),
  go: cLike(
    "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
    "true false nil iota",
    [[TEMPLATE, "string"]],
  ),
  java: cLike(
    "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try var void volatile while record sealed permits",
    "true false null",
    [[sticky("@[A-Za-z_]\\w*"), "attr"]],
  ),
  kotlin: cLike(
    "as break class continue do else for fun if in interface is object package return super this throw try typealias val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam value where abstract actual annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg",
    "true false null",
    [[sticky("@[A-Za-z_]\\w*"), "attr"]],
  ),
  swift: cLike(
    "associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private precedencegroup protocol public rethrows static struct subscript typealias var break case catch continue default defer do else fallthrough for guard if in repeat return throw switch where while Any as await async is nil super self Self throws try some any actor",
    "true false nil",
    [[sticky("[@#][A-Za-z_]\\w*"), "attr"]],
  ),
  c: cLike(
    "auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while class namespace template typename using public private protected virtual override new delete this try catch throw operator constexpr noexcept nullptr static_cast dynamic_cast reinterpret_cast const_cast int long short char float double void unsigned signed bool size_t",
    "true false NULL nullptr",
    [[sticky("^[ \\t]*#[ \\t]*\\w+"), "attr"], [sticky("<[\\w./]+>(?=\\s*$)"), "string"]],
  ),
  csharp: cLike(
    "abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw try typeof uint ulong unchecked unsafe ushort using virtual void volatile while var async await record init get set yield",
    "true false null",
  ),
  css: [
    [BLOCK, "comment"],
    [DQ, "string"],
    [SQ, "string"],
    [sticky("@[\\w-]+"), "keyword"],
    [sticky("#[\\da-fA-F]{3,8}\\b"), "number"],
    [sticky("-?\\d*\\.?\\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr|ch|ex|pt)?\\b"), "number"],
    [sticky("--[\\w-]+|[a-z-]+(?=\\s*:(?!:))"), "property"],
    [sticky("[.#]?[A-Za-z_][\\w-]*(?=[^{};]*\\{)"), "tag"],
    [sticky("[a-z-]+(?=\\()"), "function"],
    [sticky("::?[a-z-]+"), "attr"],
    [PUNCT, "punctuation"],
    [OPERATOR, "operator"],
  ],
  html: [
    [sticky("<!--[\\s\\S]*?(?:-->|(?![\\s\\S]))"), "comment"],
    [sticky("<!?[A-Za-z][\\w:-]*|</[A-Za-z][\\w:-]*|/?>"), "tag"],
    [DQ, "string"],
    [SQ, "string"],
    [sticky("[A-Za-z_:@][\\w:.-]*(?==)"), "attr"],
    [sticky("&[#\\w]+;"), "constant"],
    [sticky("="), "operator"],
  ],
  yaml: [
    [LINE_HASH, "comment"],
    [DQ, "string"],
    [SQ, "string"],
    [sticky("[\\w.\\-/]+(?=\\s*:(?:\\s|(?![\\s\\S])))"), "property"],
    [sticky("[&*][\\w-]+"), "attr"],
    [words("true false null yes no on off"), "constant"],
    [NUMBER, "number"],
    [sticky("^\\s*-(?=\\s)|---|\\.\\.\\."), "punctuation"],
    [sticky("[{}\\[\\],:|>]"), "punctuation"],
  ],
  toml: [
    [LINE_HASH, "comment"],
    [sticky('"""[\\s\\S]*?(?:"""|(?![\\s\\S]))'), "string"],
    [DQ, "string"],
    [SQ, "string"],
    [sticky("^\\s*\\[\\[?[^\\]\\n]*\\]\\]?"), "tag"],
    [sticky("[\\w.\\-]+(?=\\s*=)"), "property"],
    [words("true false"), "constant"],
    [sticky("\\d{4}-\\d\\d-\\d\\d[T\\d:.Z+-]*"), "number"],
    [NUMBER, "number"],
    [PUNCT, "punctuation"],
    [OPERATOR, "operator"],
  ],
  sql: [
    [sticky("--[^\\n]*"), "comment"],
    [BLOCK, "comment"],
    [SQ, "string"],
    [sticky('"(?:[^"\\n]|"")*"?'), "property"],
    [new RegExp("\\b(?:select|from|where|and|or|not|insert|into|values|update|set|delete|create|table|alter|drop|index|join|left|right|inner|outer|full|cross|on|as|group|by|order|having|limit|offset|union|all|distinct|null|is|in|like|between|exists|case|when|then|else|end|primary|key|foreign|references|default|unique|check|constraint|begin|commit|rollback|with|returning|asc|desc|if|view|trigger|function|returns|return|declare)\\b", "iy"), "keyword"],
    [words("true false TRUE FALSE"), "constant"],
    [new RegExp("\\b(?:int|integer|bigint|smallint|text|varchar|char|boolean|bool|date|timestamp|timestamptz|numeric|decimal|real|float|double|json|jsonb|uuid|serial)\\b", "iy"), "type"],
    [NUMBER, "number"],
    [FUNCTION_CALL, "function"],
    [OPERATOR, "operator"],
    [PUNCT, "punctuation"],
  ],
  markdown: [
    [sticky("^#{1,6}[ \\t].*"), "heading"],
    [sticky("^[ \\t]*(?:```|~~~).*"), "comment"],
    [sticky("`[^`\\n]+`"), "string"],
    [sticky("\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__"), "keyword"],
    [sticky("!?\\[[^\\]\\n]*\\](?=\\()"), "function"],
    [sticky("\\([^)\\s]+\\)"), "string"],
    [sticky("^[ \\t]*(?:[-*+]|\\d+\\.)(?=[ \\t])"), "punctuation"],
    [sticky("^>"), "comment"],
  ],
  diff: [],
};

const ALIASES: Record<string, string> = {
  js: "javascript", jsx: "javascript", javascript: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript",
  ts: "typescript", tsx: "typescript", typescript: "typescript", mts: "typescript", cts: "typescript",
  json: "json", jsonc: "json", json5: "json", jsonl: "json", webmanifest: "json",
  sh: "bash", bash: "bash", shell: "bash", zsh: "bash", console: "bash", shellscript: "bash", fish: "bash", terminal: "bash", dockerfile: "bash", env: "bash",
  py: "python", python: "python", python3: "python",
  rs: "rust", rust: "rust",
  go: "go", golang: "go",
  java: "java",
  kt: "kotlin", kts: "kotlin", kotlin: "kotlin",
  swift: "swift",
  c: "c", h: "c", cc: "c", cpp: "c", "c++": "c", cxx: "c", hpp: "c", hh: "c", objc: "c", m: "c",
  cs: "csharp", csharp: "csharp", "c#": "csharp",
  css: "css", scss: "css", less: "css", sass: "css",
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html", svelte: "html", xhtml: "html", plist: "html",
  yaml: "yaml", yml: "yaml",
  toml: "toml", ini: "toml", conf: "toml", cfg: "toml", gitignore: "toml",
  sql: "sql", psql: "sql", pgsql: "sql", mysql: "sql", sqlite: "sql",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  diff: "diff", patch: "diff",
};

export const SUPPORTED_LANGUAGES: readonly string[] = Object.keys(RULES);

/** The canonical language for a fence info string, extension or file name; null when unsupported. */
export function resolveLanguage(info: string | null | undefined): string | null {
  if (!info) return null;
  let value = info.trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^language-/, "").split(/\s+/)[0] ?? "";
  value = value.split("{")[0] ?? "";
  if (ALIASES[value]) return ALIASES[value];
  const base = value.split("/").pop() ?? value;
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "bash";
  if (base === "makefile" || base === ".gitignore" || base === ".env" || base.startsWith(".env.")) return "bash";
  const dot = base.lastIndexOf(".");
  if (dot >= 0) return ALIASES[base.slice(dot + 1)] ?? null;
  return null;
}

function mergeAdjacent(tokens: HighlightToken[]): HighlightToken[] {
  const merged: HighlightToken[] = [];
  for (const token of tokens) {
    if (token.text === "") continue;
    const last = merged[merged.length - 1];
    if (last && last.kind === token.kind) last.text += token.text;
    else merged.push({ text: token.text, kind: token.kind });
  }
  return merged;
}

const WORD = /[\w$]+/y;

function tokenizeWith(code: string, rules: Rule[]): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  let index = 0;
  while (index < code.length) {
    let matched = false;
    for (const [pattern, kind] of rules) {
      pattern.lastIndex = index;
      const found = pattern.exec(code);
      if (found && found[0].length > 0) {
        tokens.push({ text: found[0], kind });
        index += found[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      WORD.lastIndex = index;
      const step = WORD.exec(code)?.[0].length ?? 1;
      tokens.push({ text: code.slice(index, index + step), kind: "plain" });
      index += step;
    }
  }
  return mergeAdjacent(tokens);
}

/** HTML with its embedded scripts and styles tokenized as JavaScript and CSS (TextMate's embedded grammars). */
function tokenizeHtml(code: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  const embedded = /(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>|$)/gi;
  let index = 0;
  for (const match of code.matchAll(embedded)) {
    const start = match.index ?? 0;
    const open = match[1]!;
    const body = match[3]!;
    tokens.push(...tokenizeWith(code.slice(index, start + open.length), RULES.html!));
    if (body) tokens.push(...tokenizeWith(body, match[2]!.toLowerCase() === "style" ? RULES.css! : RULES.javascript!));
    if (match[4]) tokens.push(...tokenizeWith(match[4], RULES.html!));
    index = start + match[0].length;
  }
  if (index < code.length) tokens.push(...tokenizeWith(code.slice(index), RULES.html!));
  return mergeAdjacent(tokens);
}

function splitLines(tokens: HighlightToken[]): HighlightToken[][] {
  const lines: HighlightToken[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split("\n");
    parts.forEach((part, partIndex) => {
      if (partIndex > 0) lines.push([]);
      if (part !== "") lines[lines.length - 1].push({ text: part, kind: token.kind });
    });
  }
  return lines;
}

function highlightDiff(code: string): HighlightToken[][] {
  return code.split("\n").map((line) => {
    let kind: HighlightKind = "plain";
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) kind = "comment";
    else if (line.startsWith("@@")) kind = "keyword";
    else if (line.startsWith("+")) kind = "inserted";
    else if (line.startsWith("-")) kind = "deleted";
    return line === "" ? [] : [{ text: line, kind }];
  });
}

function plainLines(code: string): HighlightToken[][] {
  return code.split("\n").map((line) => (line === "" ? [] : [{ text: line, kind: "plain" as const }]));
}

/** One array of tokens per line of `code` (split on "\n"; a trailing "\r" stays in its line's last token). */
export function highlightCode(code: string, language: string | null | undefined): HighlightToken[][] {
  const id = resolveLanguage(language);
  if (!id || code === "") return plainLines(code);
  try {
    if (id === "diff") return highlightDiff(code);
    if (id === "html") return splitLines(tokenizeHtml(code));
    const rules = RULES[id];
    if (!rules) return plainLines(code);
    return splitLines(tokenizeWith(code, rules));
  } catch {
    return plainLines(code);
  }
}

/** Tokens of a single line, for diffs and previews that highlight line by line. */
export function highlightLine(line: string, language: string | null | undefined): HighlightToken[] {
  return highlightCode(line, language)[0] ?? [];
}

const TOKEN_CLASSES: Record<HighlightKind, string> = {
  plain: "text-code-foreground",
  comment: "text-[#6a737d] dark:text-[#7f8a96]",
  keyword: "text-[#c2255c] dark:text-[#ff7b9c]",
  string: "text-[#0a7a4b] dark:text-[#7ee0a8]",
  number: "text-[#b25e00] dark:text-[#ffb86c]",
  function: "text-[#3b5bdb] dark:text-[#8ab4ff]",
  type: "text-[#7048e8] dark:text-[#c4a7ff]",
  constant: "text-[#b25e00] dark:text-[#ffb86c]",
  property: "text-[#1971c2] dark:text-[#7cc4ff]",
  operator: "text-[#6a737d] dark:text-[#a0aab4]",
  punctuation: "text-[#6a737d] dark:text-[#a0aab4]",
  tag: "text-[#c2255c] dark:text-[#ff7b9c]",
  attr: "text-[#b25e00] dark:text-[#ffb86c]",
  inserted: "text-[#0a7a4b] dark:text-[#7ee0a8]",
  deleted: "text-[#c92a2a] dark:text-[#ff8787]",
  heading: "font-semibold text-[#3b5bdb] dark:text-[#8ab4ff]",
};

/** Tailwind classes that colour a token's Text in light and dark themes. */
export function tokenClass(kind: HighlightKind): string {
  return TOKEN_CLASSES[kind];
}
