// A read-only, line-numbered, highlighted view of text held in memory (files/ReadOnlySourcePreview.tsx): what an entry of an
// archive opens in, and what the rendered viewers (a page, a diagram) show as their source. The list draws only the rows in view.
import { computed, effect, List, signal, Text, View } from "nsh";
import type { ListRef } from "nsh";
import { highlightCode, resolveLanguage, tokenClass, type HighlightToken } from "../thread/markdown/highlight";
import { revealIndex } from "./fileLineReveal";
import { previewLines } from "./filesLogic";
import { createStableRows } from "../stableRows";
import { scaledFor } from "../../shell/surfaceZoom";

/** R3: code text follows the files surface zoom (shell/surfaceZoom.ts); 12/16 is text-xs. */
const filesText = () => ({ fontSize: scaledFor("files", 12), lineHeight: scaledFor("files", 16) });

interface SourceLine { id: string; n: number; text: string; tokens: HighlightToken[] }

/** The rows of a source view: one per line with its highlighted tokens (a trailing newline adds no empty line). */
export function sourceLines(text: string, name: string): SourceLine[] {
  const texts = previewLines(text);
  const tokens = highlightCode(texts.join("\n"), resolveLanguage(name));
  return texts.map((line, index) => ({ id: String(index), n: index + 1, text: line, tokens: tokens[index] ?? [] }));
}

export function SourceView(props: { name: string; text: string; wrap: () => boolean; line?: number | undefined; testID?: string }) {
  const stableLines = createStableRows<SourceLine>((line) => line.id);
  const lines = computed(() => stableLines(props.name, sourceLines(props.text, props.name)));
  const list = signal<ListRef | null>(null);
  const gutter = () => Math.max(3, String(lines().length).length) * scaledFor("files", 8) + 16;
  effect(() => {
    const index = revealIndex(props.line, lines().length);
    const current = list();
    if (index === null || !current) return;
    const frame = requestAnimationFrame(() => current.scrollToIndex({ index, animated: false, viewPosition: 0.5 }));
    return () => cancelAnimationFrame(frame);
  });
  if (props.text === "") return <Text class="px-3 py-4 text-xs text-muted-foreground">This file is empty.</Text>;
  return (
    <List ref={(node) => list.set(node)} each={lines()} keyExtractor={(line) => line.id} class="min-h-0 flex-1" contentClass="pb-4" testID={props.testID ?? "Source preview"}>
      {(line) => (
        <View testID={props.line === line().n ? "Revealed line" : undefined} class={`min-h-5 flex-row ${props.line === line().n ? "bg-muted-40" : ""}`}>
          <Text style={{ width: gutter(), ...filesText() }} class="shrink-0 pr-3 text-right font-mono text-xs text-muted-foreground">{String(line().n)}</Text>
          <Text style={filesText()} class={`min-w-0 flex-1 font-mono text-xs text-foreground ${props.wrap() ? "" : "truncate"}`}>{line().tokens.length === 0 ? (line().text || " ") : line().tokens.map((token) => <Text class={tokenClass(token.kind)}>{token.text}</Text>)}</Text>
        </View>
      )}
    </List>
  );
}
