// The full file behind a preview `projects.readFile` cut short (files/LargeTextViewer.tsx and WorkspaceLargeTextPreview): a
// "Full file" strip with Copy contents, a status row (lines or rows, columns, size) and a virtualised view, so a file of millions
// of lines opens at once and only the rows on screen are decoded. A delimited file shows as a grid with its header.
// The web app's Save file downloads a copy through the browser; here the file is already on this disk, so there is nothing to
// download and the button is left out.
import { Clipboard, computed, effect, List, signal, Text, View } from "nsh";
import type { ListRef } from "nsh";
import { FileGrid } from "./FileGrid";
import { FileSurfaceAction, FileSurfaceFailure, FileSurfaceLoading, FILE_SURFACE_SUBHEADER_CLASS } from "./fileSurfaceChrome";
import { formatByteLength } from "./filesLogic";
import { indexLargeText, largeRevealIndex, largeTextSummary, type LargeText } from "./largeText";
import { readWorkspaceBytes } from "./workspaceBytes";
import { showToast } from "../toast";

/** What a read of the whole file may hold in memory. */
export const LARGE_TEXT_MAX_BYTES = 512 * 1024 * 1024;

type ReadBytes = (cwd: string, relativePath: string, maxBytes: number) => Promise<Uint8Array>;

export function LargeTextView(props: { cwd: string; relativePath: string; delimiter: "," | "\t" | null; line?: number | undefined; wrap: () => boolean; readBytes?: ReadBytes }) {
  const read = props.readBytes ?? readWorkspaceBytes;
  const text = signal<LargeText | null>(null);
  const error = signal("");
  const copied = signal(false);
  const list = signal<ListRef | null>(null);
  let generation = 0;
  async function load() {
    const request = ++generation;
    text.set(null);
    error.set("");
    try {
      const bytes = await read(props.cwd, props.relativePath, LARGE_TEXT_MAX_BYTES);
      if (request !== generation) return;
      text.set(indexLargeText(bytes, props.delimiter));
    } catch (cause) {
      if (request === generation) error.set(cause instanceof Error ? cause.message : "Unable to load file preview.");
    }
  }
  effect(() => {
    void props.cwd;
    void props.relativePath;
    void props.delimiter;
    void load();
    return () => { generation++; };
  });
  const indices = computed(() => Array.from({ length: text()?.count ?? 0 }, (_value, index) => index));
  const gutter = () => Math.max(3, String(text()?.count ?? 0).length) * 8 + 16;
  const reveal = () => largeRevealIndex(props.line, text()?.count ?? 0);
  effect(() => {
    const index = reveal();
    const current = list();
    if (index === null || !current || props.delimiter !== null) return;
    const frame = requestAnimationFrame(() => current.scrollToIndex({ index, animated: false, viewPosition: 0.5 }));
    return () => cancelAnimationFrame(frame);
  });
  async function copyContents() {
    const current = text();
    if (!current) return;
    try { await Clipboard.writeText(current.text()); copied.set(true); setTimeout(() => copied.set(false), 1500); } catch (cause) { showToast({ type: "error", title: "Could not read file", description: cause instanceof Error ? cause.message : "Try again." }); }
  }
  return (
    <View class="min-h-0 flex-1" accessibilityLabel="Full file">
      <View class={FILE_SURFACE_SUBHEADER_CLASS}>
        <Text class="min-w-0 flex-1 text-xs text-muted-foreground">Full file</Text>
        <FileSurfaceAction label={copied() ? "Copied" : "Copy contents"} icon={copied() ? "check" : "copy"} onPress={() => void copyContents()} />
      </View>
      {error() ? <FileSurfaceFailure message={error()} onRetry={() => void load()} /> : null}
      {!error() && text() === null ? <FileSurfaceLoading /> : null}
      {text() !== null ? (
        <View class="min-h-0 flex-1">
          <View class="min-h-10 shrink-0 justify-center border-b border-border-60 px-3 py-2"><Text class="text-xs text-muted-foreground" accessibilityLabel="Large file summary">{largeTextSummary(text()!, props.delimiter, formatByteLength)}</Text></View>
          {text()!.count === 0 ? <View class="flex-1 items-center justify-center p-6"><Text class="text-xs text-muted-foreground">This file is empty.</Text></View> : null}
          {text()!.count > 0 && props.delimiter !== null ? (
            <FileGrid name={props.relativePath} count={text()!.count} columns={text()!.columns} header={text()!.cells(0)} row={(index) => text()!.cells(index)} wrap={props.wrap} revealRow={reveal()} />
          ) : null}
          {text()!.count > 0 && props.delimiter === null ? (
            <List ref={(node) => list.set(node)} each={indices()} keyExtractor={(index) => String(index)} class="min-h-0 flex-1" contentClass="pb-4" estimatedItemSize={20} testID="Large file lines">
              {(index) => (
                <View testID={reveal() === index() ? "Revealed line" : undefined} class={`min-h-5 flex-row ${reveal() === index() ? "bg-muted-40" : ""}`}>
                  <Text style={{ width: gutter() }} class="shrink-0 pr-3 text-right font-mono text-xs text-muted-foreground">{String(index() + 1)}</Text>
                  <Text class={`min-w-0 flex-1 font-mono text-xs text-foreground ${props.wrap() ? "" : "truncate"}`}>{text()!.record(index()) || " "}</Text>
                </View>
              )}
            </List>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
