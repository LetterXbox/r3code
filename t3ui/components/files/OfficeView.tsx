// Office, OpenDocument and EPUB files (files/OfficeViewer.tsx): pages, slides or chapters of text with a strip to move between
// them, sheets of cell values with a strip to pick the sheet. The reading is officeDocs.ts; what the reference's engine draws
// beyond it (page layout, images, charts, formatting) is not drawn, and the notices say so, as the web app's own do for the
// formats it also shows as text.
import { computed, effect, Scroll, signal, Text, View } from "nsh";
import { HIcon } from "../header/HeaderIcons";
import { FileGrid } from "./FileGrid";
import { popupOverOverlay } from "./filePopup";
import { FileSurfaceAction, FileSurfaceFailure, FileSurfaceLoading, FileSurfaceNotice } from "./fileSurfaceChrome";
import { formatByteLength } from "./filesLogic";
import { OFFICE_MAX_BYTES, openOfficeDocument, type DocBlock, type OfficeFormat, type OfficeResult, type Run, type SheetData } from "./officeDocs";
import { readWorkspaceBytes } from "./workspaceBytes";

type ReadBytes = (cwd: string, relativePath: string, maxBytes: number) => Promise<Uint8Array>;

const group = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function runClass(run: Run): string {
  return [run.bold ? "font-bold" : "", run.italic ? "italic" : "", run.underline ? "underline" : "", run.strike ? "line-through" : "", run.code ? "font-mono" : ""].filter(Boolean).join(" ");
}

const HEADING_CLASS = ["text-xl font-semibold", "text-lg font-semibold", "text-base font-semibold", "text-sm font-semibold", "text-sm font-medium", "text-sm font-medium"];

/** DocumentPages' reading size: 50% to 200% in quarters; headings and body text scale with it (0 px = the class's own). */
const HEADING_PX = [20, 18, 16, 14, 14, 14];
const scaled = (px: number, zoom: number) => (zoom === 1 ? undefined : { fontSize: px * zoom, lineHeight: px * zoom * 1.65 });

function RunsText(props: { runs: readonly Run[]; class: string; style?: { fontSize: number; lineHeight: number } | undefined }) {
  return <Text class={props.class} {...(props.style ? { style: props.style } : {})}>{props.runs.map((run) => <Text class={runClass(run)}>{run.text}</Text>)}</Text>;
}

function BlockView(props: { block: DocBlock; zoom?: number }) {
  const block = props.block;
  const zoom = props.zoom ?? 1;
  if (block.kind === "heading") return <RunsText class={`pt-3 text-foreground ${HEADING_CLASS[Math.min(5, block.level - 1)]}`} style={scaled(HEADING_PX[Math.min(5, block.level - 1)]!, zoom)} runs={block.runs} />;
  if (block.kind === "paragraph") return <View class={block.quote ? "border-l-2 border-border pl-3" : ""}><RunsText class="text-sm leading-relaxed text-foreground" style={scaled(14, zoom)} runs={block.runs} /></View>;
  if (block.kind === "item") return (
    <View class="flex-row gap-2" style={{ paddingLeft: block.depth * 20 }}>
      <Text class="w-6 shrink-0 text-right text-sm text-muted-foreground" {...(scaled(14, zoom) ? { style: scaled(14, zoom)! } : {})}>{block.marker}</Text>
      <View class="min-w-0 flex-1"><RunsText class="text-sm leading-relaxed text-foreground" style={scaled(14, zoom)} runs={block.runs} /></View>
    </View>
  );
  if (block.kind === "code") return <View class="rounded-md bg-muted-40 px-3 py-2"><Text class="font-mono text-xs text-foreground">{block.text}</Text></View>;
  if (block.kind === "rule") return <View class="my-2 h-px bg-border" />;
  return (
    <View class="border border-border-60" accessibilityLabel="Document table">
      {block.rows.map((row) => (
        <View class="flex-row border-b border-border-60">
          {row.map((cell) => <View class="min-w-0 flex-1 border-r border-border-60 px-2 py-1"><Text class="text-xs text-foreground">{cell}</Text></View>)}
        </View>
      ))}
    </View>
  );
}

export function DocumentPage(props: { blocks: readonly DocBlock[]; name: string; zoom?: number }) {
  return (
    <Scroll class="min-h-0 flex-1" contentClass="gap-2 px-6 py-4" accessibilityLabel={props.name} testID="Document page">
      {props.blocks.length === 0 ? <Text class="text-xs text-muted-foreground">This page is empty.</Text> : props.blocks.map((block) => <BlockView block={block} zoom={props.zoom ?? 1} />)}
    </Scroll>
  );
}

/** OfficeViewer's timeout copy and bound. */
export const OFFICE_PREVIEW_TIMEOUT = "This document took too long to preview. Open it in another app.";
export const OFFICE_PREVIEW_TIMEOUT_MS = 30_000;

export function OfficeView(props: { cwd: string; relativePath: string; format: OfficeFormat; readBytes?: ReadBytes }) {
  const read = props.readBytes ?? readWorkspaceBytes;
  const result = signal<OfficeResult | null>(null);
  const size = signal(0);
  const error = signal("");
  const page = signal(0);
  const readingSize = signal(1);
  const sheet = signal<SheetData | null>(null);
  const sheetError = signal("");
  let generation = 0;
  async function load() {
    const request = ++generation;
    result.set(null);
    error.set("");
    page.set(0);
    try {
      // OfficeViewer's 30 s bound on reading and preparing the document (the parse here is synchronous, so it bounds the read).
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bytes = await Promise.race([
        read(props.cwd, props.relativePath, OFFICE_MAX_BYTES),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(OFFICE_PREVIEW_TIMEOUT)), OFFICE_PREVIEW_TIMEOUT_MS); }),
      ]).finally(() => clearTimeout(timer));
      if (request !== generation) return;
      size.set(bytes.length);
      result.set(openOfficeDocument(props.relativePath, bytes));
    } catch (cause) {
      if (request === generation) error.set(cause instanceof Error ? cause.message : "Could not render this Office document.");
    }
  }
  effect(() => {
    void props.cwd;
    void props.relativePath;
    void load();
    return () => { generation++; };
  });
  // The sheet in front is read when it is first asked for.
  effect(() => {
    const current = result();
    const index = page();
    sheet.set(null);
    sheetError.set("");
    if (current?.type !== "sheets") return;
    try { sheet.set(current.load(index)); } catch (cause) { sheetError.set(cause instanceof Error ? cause.message : "Could not read this sheet."); }
  });
  const doc = () => { const current = result(); return current?.type === "document" ? current : null; };
  const book = () => { const current = result(); return current?.type === "sheets" ? current : null; };
  const count = computed(() => doc()?.pages.length ?? book()?.names.length ?? 0);
  const navigation = () => (book() ? "sheet" : (doc()?.navigation ?? "slide"));
  const showStrip = () => (book() ? count() > 0 : count() > 1);
  const details = () => {
    const current = doc();
    if (!current) return "";
    const label = current.navigation === "chapter" ? `Chapter ${page() + 1} of ${current.pages.length}` : `${current.pages.length} ${current.navigation}${current.pages.length === 1 ? "" : "s"}`;
    return `${label} · ${size() === 0 ? "0 bytes" : formatByteLength(size())}`;
  };
  const titles = () => doc()?.pages.map((item) => item.title) ?? book()?.names ?? [];
  function pick(at: { x: number; y: number }) {
    void popupOverOverlay(titles().map((title, index) => ({ label: title, checked: index === page(), onSelect: () => page.set(index) })), at, "sheet menu");
  }
  const pickable = () => book() !== null || doc()?.navigation === "chapter";
  const rows = () => sheet()?.rows ?? [];
  return (
    <View class="min-h-0 flex-1" accessibilityLabel="Document">
      {error() ? (
        <View role="alert" class="min-h-0 flex-1 items-center justify-center gap-1 px-6">
          <Text class="text-center text-sm font-medium text-foreground">No preview for this file</Text>
          <Text class="max-w-sm text-center text-xs leading-relaxed text-muted-foreground">{`${error()} Save it or open it in another app.`}</Text>
        </View>
      ) : null}
      {!error() && result() === null ? <FileSurfaceLoading /> : null}
      {!error() && result() !== null && showStrip() ? (
        <View class="h-10 shrink-0 flex-row items-center gap-2 border-b border-border-60 px-3">
          <FileSurfaceAction label={`Previous ${navigation()}`} icon="chevron-left" disabled={page() === 0} onPress={() => page.update((value) => value - 1)} />
          {pickable() ? (
            <View role="button" accessibilityLabel={book() ? "Sheet" : "Chapter"} onPress={(event) => pick({ x: event.pagePosition.x, y: event.pagePosition.y })} class="h-7 min-w-0 flex-1 flex-row items-center gap-2 rounded-lg border border-input px-2">
              <Text class="min-w-0 flex-1 truncate text-xs text-foreground">{titles()[page()] ?? ""}</Text>
              <HIcon name="chevrons-up-down" size={12} />
            </View>
          ) : <Text class="flex-1 text-center text-xs text-foreground" accessibilityLabel={`${navigation() === "slide" ? "Slide" : "Page"} ${page() + 1} of ${count()}`}>{`${navigation() === "slide" ? "Slide" : "Page"} ${page() + 1} of ${count()}`}</Text>}
          <FileSurfaceAction label={`Next ${navigation()}`} icon="chevron-right" disabled={page() + 1 >= count()} onPress={() => page.update((value) => value + 1)} />
        </View>
      ) : null}
      {doc() ? (
        <View class="min-h-0 flex-1">
          {/* DocumentPages' strip: the details, then Decrease / percentage / Increase / Reset reading size. */}
          <View class="min-h-10 shrink-0 flex-row flex-wrap items-center gap-1 border-b border-border-60 px-3 py-1">
            <Text class="min-w-0 flex-1 text-xs tabular-nums text-muted-foreground" accessibilityLabel={details()}>{!showStrip() ? details() : ""}</Text>
            <FileSurfaceAction label="Decrease reading size" icon="minus" disabled={readingSize() <= 0.5} onPress={() => readingSize.set(Math.max(0.5, readingSize() - 0.25))} />
            <Text class="min-w-10 text-center text-xs tabular-nums text-muted-foreground">{`${Math.round(readingSize() * 100)}%`}</Text>
            <FileSurfaceAction label="Increase reading size" icon="plus" disabled={readingSize() >= 2} onPress={() => readingSize.set(Math.min(2, readingSize() + 0.25))} />
            <FileSurfaceAction label="Reset reading size" icon="rotate-ccw" disabled={readingSize() === 1} onPress={() => readingSize.set(1)} />
          </View>
          {doc()!.navigation !== "chapter" ? <FileSurfaceNotice text="Text and images. Layout and embedded objects may differ from the original." /> : null}
          <DocumentPage name={`${props.relativePath}: ${doc()!.pages[page()]?.title ?? ""}`} blocks={doc()!.pages[page()]?.blocks ?? []} zoom={readingSize()} />
        </View>
      ) : null}
      {book() && sheetError() ? <FileSurfaceFailure message={sheetError()} /> : null}
      {book() && sheet() ? (
        <View class="min-h-0 flex-1">
          <View class="min-h-10 shrink-0 justify-center border-b border-border-60 px-3 py-2"><Text class="text-xs text-muted-foreground">{`Sheet ${page() + 1} of ${count()} · ${group(sheet()!.rowCount)} rows · ${group(sheet()!.columns)} columns${size() ? ` · ${formatByteLength(size())}` : ""}`}</Text></View>
          <FileSurfaceNotice text={`Cell values only. Charts, images, and formatting are not shown.${sheet()!.truncated ? book()!.limited : ""}`} />
          {sheet()!.rowCount === 0 ? <Text class="p-6 text-xs text-muted-foreground">This sheet is empty.</Text> : (
            <FileGrid name={`${props.relativePath}: ${sheet()!.name}`} count={sheet()!.rowCount} columns={sheet()!.columns} row={(index) => rows()[index] ?? []} wrap={() => false} />
          )}
        </View>
      ) : null}
    </View>
  );
}
