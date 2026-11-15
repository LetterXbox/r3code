import { colorScheme, Text, View } from "nsh";
import { codeTextStyle } from "../../../typography";
import { tokenClass } from "./highlight";
import { highlightCodeShiki, type ShikiToken } from "./shikiHighlight";
import { FIND_ACTIVE_HIGHLIGHT, findCodeMatches, splitTokensAtMatches } from "../threadFind";
import { activeFindQuery } from "../threadFindState";

/**
 * Port of chat/HighlightedCodeLines.tsx: one Text per line with a nested Text per
 * token, coloured by highlight.ts. Lines are keyed by index so a streaming block
 * that only appends keeps the earlier lines' views. threadFindHighlights: find matches
 * in the code are drawn on the search-match colours, `activeMatch` on the active one.
 */
export function HighlightedCodeLines(props: { code: () => string; language: () => string; wrap?: () => boolean; activeMatch?: () => number | null }) {
  // Shiki grammars (all bundled languages) once loaded; the regex highlighter until then.
  const lines = () => highlightCodeShiki(props.code(), props.language(), colorScheme());
  const tokenClassOf = (token: ShikiToken) => `${token.color ? "" : tokenClass(token.kind)}${token.italic ? " italic" : ""}${token.bold ? " font-bold" : ""}${token.underline ? " underline" : ""}`;
  const tokenStyle = (token: ShikiToken) => (token.color ? { color: token.color } : undefined);
  const matches = () => findCodeMatches(props.code(), activeFindQuery());
  const lineStarts = () => { const starts: number[] = []; let at = 0; for (const line of props.code().split("\n")) { starts.push(at); at += line.length + 1; } return starts; };
  const matchStyle = (index: number) => (index === props.activeMatch?.() ? { backgroundColor: FIND_ACTIVE_HIGHLIGHT, color: "#2a2116" } : colorScheme() === "dark" ? { backgroundColor: "#8a7232", color: "#f7f7f7" } : { backgroundColor: "#f3d98a", color: "#2a2116" });
  return (
    <View class={props.wrap?.() === false ? "min-w-full" : "min-w-0"} selectable>
      <Each of={lines()} key="index">
        {(line, index) => (
          <Text class="leading-snug text-code-foreground" style={codeTextStyle()}>
            {line().length === 0
              ? " "
              : matches().length === 0
                ? line().map((token) => <Text class={tokenClassOf(token)} style={tokenStyle(token)}>{token.text}</Text>)
                : splitTokensAtMatches(line(), matches(), lineStarts()[index()] ?? 0).map((piece) => <Text class={tokenClassOf(piece)} style={piece.match === null ? tokenStyle(piece) : matchStyle(piece.match)}>{piece.text}</Text>)}
          </Text>
        )}
      </Each>
    </View>
  );
}
