// composerMathRanges (shared/composerInlineTokens.ts over markdownMathRanges): the inline formulas of one line of
// prompt text, as remark-math reads them with single-dollar math on: `$x$`, `$$x$$` (a run of N dollars closes with a
// run of exactly N), and `\(x\)`. Code spans and backslash-escaped dollars are not math. The composer shows a formula as
// editable source, shielding its commands and Markdown-like markers from styling and context-chip parsing.
export interface MathRange { start: number; end: number; source: string }

const runLength = (text: string, at: number, char: string) => { let end = at; while (text[end] === char) end += 1; return end - at; };

/** `links` are the `[label](target)` spans of confirmed mentions: masked with letters so their `$` cannot open a formula. */
export function composerMathRanges(source: string, links: readonly { start: number; end: number }[] = []): MathRange[] {
  if (!source.includes("$") && !source.includes("\\(")) return [];
  let text = source;
  for (const link of links) text = text.slice(0, link.start) + "x".repeat(link.end - link.start) + text.slice(link.end);
  const ranges: MathRange[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\\") {
      if (text[index + 1] === "(") {
        const close = text.indexOf("\\)", index + 2);
        if (close > index + 2) { ranges.push({ start: index, end: close + 2, source: source.slice(index, close + 2) }); index = close + 2; continue; }
      }
      index += 2;
      continue;
    }
    if (char === "`") {
      const size = runLength(text, index, "`");
      let search = index + size;
      let closed = -1;
      while (search < text.length) {
        const at = text.indexOf("`", search);
        if (at < 0) break;
        const run = runLength(text, at, "`");
        if (run === size) { closed = at + run; break; }
        search = at + run;
      }
      index = closed >= 0 ? closed : index + size;
      continue;
    }
    if (char === "$") {
      const size = runLength(text, index, "$");
      let search = index + size;
      let closed = -1;
      while (search < text.length) {
        const at = text.indexOf("$", search);
        if (at < 0) break;
        if (text[at - 1] === "\\") { search = at + 1; continue; }
        const run = runLength(text, at, "$");
        // markdownMath.test.ts "keeps prices, shell variables, and skill tokens as prose": a single dollar right before a
        // word character, `{`, `(`, `?` or `@` does not close (`$5-$10`, `$HOME,$PATH`, `$nope $council`); the opener
        // fails there and that dollar may open a formula of its own (`$5-$10 ... $x_i$`).
        if (run === size && size === 1 && /[\p{L}\p{N}_{(?@]/u.test(text[at + run] ?? "")) { closed = -2; search = at; break; }
        if (run === size) { closed = at + run; break; }
        search = at + run;
      }
      if (closed === -2) { index = search; continue; }
      if (closed > index + size * 2) { ranges.push({ start: index, end: closed, source: source.slice(index, closed) }); index = closed; continue; }
      index += size;
      continue;
    }
    index += 1;
  }
  return ranges;
}
