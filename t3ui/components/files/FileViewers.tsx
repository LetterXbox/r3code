// The viewers beside the source view (files/DelimitedTablePreview.tsx, NotebookPreview.tsx, PdfViewer.tsx,
// AudioPreview.tsx, FontFilePreview.tsx, BinaryFilePreview.tsx, OfficeFilePreview.tsx). Tables and notebooks draw natively
// from the text `projects.readFile` returns; a PDF, audio file or font is hosted by a WebView straight from the file;
// anything else gets the unavailable state with the open actions.
import { FileSurfaceNotice } from "./fileSurfaceChrome";
import { fontSampleHtml, MAX_FONT_BYTES } from "./RenderedViews";
import { base64Chunks } from "./documentViewerPages";
import { readWorkspaceBytes } from "./workspaceBytes";
import { computed, Image, List, Scroll, signal, Text, View, WebView } from "nsh";
import { highlightCode, resolveLanguage, tokenClass } from "../thread/markdown/highlight";
import { ChatMarkdown } from "../thread/markdown/ChatMarkdown";
import { measureInto, panelViewOccluded, type PageRect } from "../rightPanel/nativeOcclusion";
import { columnWidths, parseDelimited, type DelimitedTable } from "./delimited";
import { audioPreviewHtml, folderFileUrl, fontPreviewHtml, unsupportedMessage, type FilePreviewKind } from "./filePreviewKind";
import { parseNotebook, type NotebookCell } from "./notebook";
import { workspaceFileUrl } from "./filesLogic";
import { createStableRows } from "../stableRows";

const CHAR_WIDTH = 7;

export function DelimitedTableView(props: { text: string; delimiter: "," | "\t"; wrap: () => boolean }) {
  const table = computed<DelimitedTable>(() => parseDelimited(props.text, props.delimiter));
  const widths = computed(() => columnWidths(table().rows));
  const header = () => table().rows[0] ?? [];
  const stableRows = createStableRows<{ id: string; cells: string[] }>((row) => row.id);
  const body = computed(() => stableRows(props.delimiter, table().rows.slice(1).map((cells, index) => ({ id: String(index), cells }))));
  const cell = (text: string, index: number, strong: boolean) => (
    <View style={{ width: (widths()[index] ?? 8) * CHAR_WIDTH + 16 }} class="shrink-0 px-2 py-1">
      <Text class={`text-xs ${strong ? "font-medium text-foreground" : "text-foreground"} ${props.wrap() ? "" : "truncate"}`}>{text}</Text>
    </View>
  );
  return (
    <View class="min-h-0 flex-1" accessibilityLabel="Table preview">
      {table().rows.length === 0 ? <Text class="px-3 py-4 text-xs text-muted-foreground">This file is empty.</Text> : (
        <Scroll horizontal class="min-h-0 flex-1" contentClass="min-h-0">
          <View class="min-h-0 flex-1">
            <View class="flex-row border-b border-border bg-background" accessibilityLabel="Table header">{header().map((text, index) => cell(text, index, true))}</View>
            <List each={body()} keyExtractor={(row) => row.id} class="min-h-0 flex-1" contentClass="pb-4" testID="Table rows">
              {(row) => <View class="flex-row border-b border-border-60" testID="Table row">{row().cells.map((text, index) => cell(text, index, false))}</View>}
            </List>
          </View>
        </Scroll>
      )}
      {table().omitted > 0 ? <Text class="border-t border-border px-3 py-2 text-xs text-muted-foreground">{`Showing the first ${table().rows.length} rows. ${table().omitted} more are not shown.`}</Text> : null}
    </View>
  );
}

function CellView(props: { cell: NotebookCell; language: string }) {
  const cell = props.cell;
  const tokens = () => (cell.type === "code" ? highlightCode(cell.source, resolveLanguage(`cell.${props.language === "python" ? "py" : props.language}`)) : []);
  return (
    <View class="gap-1 border-b border-border-60 px-3 py-2" testID={`Notebook cell ${cell.type}`}>
      {cell.type === "markdown" ? <ChatMarkdown text={() => cell.source} /> : (
        <View class="flex-row gap-2">
          <Text class="w-10 shrink-0 text-right font-mono text-2xs text-muted-foreground">{cell.type === "code" ? `[${cell.executionCount ?? " "}]` : ""}</Text>
          <View class="min-w-0 flex-1 gap-1">
            <View class="rounded-md bg-muted-40 px-2 py-1">
              {cell.source.split("\n").map((line, index) => (
                <Text class="font-mono text-xs text-foreground">{(tokens()[index] ?? []).length === 0 ? (line || " ") : (tokens()[index] ?? []).map((token) => <Text class={tokenClass(token.kind)}>{token.text}</Text>)}</Text>
              ))}
            </View>
            {cell.outputs.map((output) => output.kind === "image"
              ? <Image src={output.src} class="max-w-full" style={{ objectFit: "contain" }} accessibilityLabel="Notebook output image" />
              : <Text class={`font-mono text-xs ${output.kind === "error" || (output.kind === "text" && output.stream === "stderr") ? "text-destructive" : "text-muted-foreground"}`}>{output.text}</Text>)}
          </View>
        </View>
      )}
    </View>
  );
}

export function NotebookView(props: { text: string }) {
  const parsed = (): { notebook: ReturnType<typeof parseNotebook> } | { error: string } => {
    try { return { notebook: parseNotebook(props.text) }; } catch (cause) { return { error: cause instanceof Error ? cause.message : String(cause) }; }
  };
  const result = parsed();
  if ("error" in result) return <Text class="p-4 text-xs text-destructive" role="alert">{result.error}</Text>;
  const cells = result.notebook.cells.map((cell) => ({ ...cell }));
  return (
    <View class="min-h-0 flex-1 flex-col">
      <FileSurfaceNotice text="Saved outputs only. Code is never executed." />
      <Scroll class="min-h-0 flex-1" contentClass="pb-4" testID="Notebook preview" accessibilityLabel="Notebook preview">
        {cells.length === 0 ? <Text class="p-4 text-sm text-muted-foreground">This notebook is empty.</Text> : cells.map((cell) => <CellView cell={cell} language={result.notebook.language} />)}
      </Scroll>
    </View>
  );
}

/** A font sample or rendered HTML in a WebView; it steps aside, like every native view, while an overlay is open. The GPUI
 * host takes a page only as an HTML string: a font is inlined (FontViewer's 10 MB bound and errors), an HTML file is its own
 * text (relative resources do not resolve). PDFs and audio have their own viewers (DocumentViewer, AudioFileView). */
export function HostedFileView(props: { kind: "pdf" | "audio" | "font" | "html"; cwd: string; relativePath: string; onFailure: (message: string) => void; readBytes?: (cwd: string, relativePath: string, maxBytes: number) => Promise<Uint8Array> }) {
  const ownRect = signal<PageRect | null>(null);
  let host: { measure(): Promise<any> } | undefined;
  const occluded = () => panelViewOccluded(ownRect());
  const html = signal<string | null>(null);
  const failure = signal("");
  const read = props.readBytes ?? readWorkspaceBytes;
  const extension = props.relativePath.slice(props.relativePath.lastIndexOf(".") + 1).toLowerCase();
  void read(props.cwd, props.relativePath, props.kind === "font" ? MAX_FONT_BYTES : 50 * 1024 * 1024).then((bytes) => {
    if (props.kind === "font") html.set(fontSampleHtml(base64Chunks(bytes, bytes.length || 1).join(""), extension === "otf" ? "font/otf" : extension === "woff2" ? "font/woff2" : extension === "woff" ? "font/woff" : "font/ttf"));
    else html.set(new TextDecoder().decode(bytes));
  }).catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    failure.set(props.kind === "font" ? (message.startsWith("Preview limited") ? "Font previews are limited to 10 MB." : "The font could not be loaded.") : message);
    props.onFailure(failure());
  });
  return (
    <View ref={(node: any) => { host = node; }} onLayout={() => measureInto(host, ownRect)} class="min-h-0 flex-1 bg-background" accessibilityLabel={`${props.kind === "pdf" ? "PDF" : props.kind === "html" ? "HTML" : props.kind === "audio" ? "Audio" : "Font"} preview`}>
      {failure() && props.kind === "font" ? (
        <View role="alert" class="min-h-0 flex-1 items-center justify-center gap-1 px-6">
          <Text class="text-center text-sm font-medium text-foreground">No preview for this file</Text>
          <Text class="max-w-sm text-center text-xs text-muted-foreground">{`${failure()} Save it to open in another app.`}</Text>
        </View>
      ) : null}
      {occluded() ? <View class="min-h-0 flex-1 bg-background" testID="File view occluded" /> : null}
      {html() !== null ? <WebView html={html()!} class={occluded() ? "hidden" : "min-h-0 flex-1"} onError={(event) => props.onFailure(event.message || "The file could not be loaded. Close it and try again.")} /> : null}
    </View>
  );
}

/** Binary, archive and office files: the reference's unavailable state, with the actions that can open them. */
export function UnsupportedFileView(props: { kind: FilePreviewKind; message?: string; onOpen: () => void; onReveal: () => void; canOpen: boolean }) {
  const button = (label: string, onPress: () => void) => (
    <View role="button" accessibilityLabel={label} onPress={onPress} class="h-7 items-center justify-center rounded-lg border border-input px-3 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"><Text class="text-xs text-foreground">{label}</Text></View>
  );
  return (
    <View class="min-h-0 flex-1 items-center justify-center gap-3 px-6" accessibilityLabel="File not shown" testID="Unsupported file">
      <Text class="text-center text-xs text-muted-foreground">{props.message ?? unsupportedMessage(props.kind)}</Text>
      {props.canOpen ? <View class="flex-row gap-2">{button("Open in editor", props.onOpen)}{button("Reveal in file manager", props.onReveal)}</View> : null}
    </View>
  );
}
