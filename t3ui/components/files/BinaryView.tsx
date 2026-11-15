// Archives and SQLite databases (files/BinaryViewer.tsx): an archive lists its entries by folder and opens a text or image
// entry in place; a database shows one table at a time, 50 rows to a page, read-only. Both are parsed from the file's bytes
// (archiveReader.ts, sqliteReader.ts).
import { computed, effect, Image, List, Scroll, signal, Text, View } from "nsh";
import { HIcon } from "../header/HeaderIcons";
import { createStableRows } from "../stableRows";
import { popupOverOverlay } from "./filePopup";
import { archiveFolderRows, archiveParentFolder, openArchive, type ArchiveRow, type OpenArchive } from "./archiveReader";
import { FileSurfaceAction, FileSurfaceFailure, FileSurfaceLoading, FileSurfaceNotice } from "./fileSurfaceChrome";
import { filePreviewKind } from "./filePreviewKind";
import { formatByteLength } from "./filesLogic";
import { openSqlite, SQLITE_PAGE_SIZE, type OpenSqlite } from "./sqliteReader";
import { SourceView } from "./SourceView";
import { decodePreviewText, readWorkspaceBytes } from "./workspaceBytes";

export const BINARY_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

type ReadBytes = (cwd: string, relativePath: string, maxBytes: number) => Promise<Uint8Array>;

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif", svg: "image/svg+xml" };

/** The date column: the locale's short date, or the ISO date where the runtime has no locale data. */
function entryDate(iso: string | null): string {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  try { return date.toLocaleDateString(); } catch { return iso.slice(0, 10); }
}

const group = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function ArchiveEntryView(props: { archive: OpenArchive; path: string }) {
  const state = computed(() => {
    const kind = filePreviewKind(props.path);
    try {
      const bytes = props.archive.read(props.path);
      if (kind === "image") {
        const extension = props.path.slice(props.path.lastIndexOf(".") + 1).toLowerCase();
        return { kind: "image" as const, url: URL.createObjectURL(new Blob([bytes], { type: IMAGE_TYPES[extension] ?? "application/octet-stream" })) };
      }
      if (kind === "text" || kind === "markdown" || kind === "html" || kind === "mermaid") {
        const { text, truncated } = decodePreviewText(bytes);
        return { kind: "text" as const, text, truncated };
      }
      return { kind: "failure" as const, message: "Only UTF-8 text and images can be opened inside an archive." };
    } catch (cause) {
      return { kind: "failure" as const, message: cause instanceof Error ? cause.message : "This archive entry is unavailable." };
    }
  });
  const shown = () => state();
  return (
    <View class="min-h-0 flex-1">
      {shown().kind === "image" ? <View class="min-h-0 flex-1 items-center justify-center p-4" accessibilityLabel="Image preview"><Image src={(shown() as { url: string }).url} accessibilityLabel={props.path} class="max-h-full max-w-full" style={{ objectFit: "contain" }} /></View> : null}
      {shown().kind === "failure" ? <FileSurfaceFailure message={(shown() as { message: string }).message} /> : null}
      {shown().kind === "text" ? (
        <View class="min-h-0 flex-1">
          {(shown() as { truncated: boolean }).truncated ? <FileSurfaceNotice text="Preview limited to the first 1 MB." /> : null}
          <SourceView name={props.path} text={(shown() as { text: string }).text} wrap={() => false} testID="Archive entry" />
        </View>
      ) : null}
    </View>
  );
}

function ArchiveBrowser(props: { archive: OpenArchive; sizeBytes: number }) {
  const folder = signal("");
  const selected = signal<string | null>(null);
  const stableRows = createStableRows<ArchiveRow>((row) => `${row.path}${row.directory ? "/" : ""}`);
  const rows = computed(() => stableRows(folder(), archiveFolderRows(props.archive.entries, folder())));
  const rowLabel = (row: ArchiveRow) => row.path.slice(folder().length);
  return (
    <View class="min-h-0 flex-1" accessibilityLabel="Archive">
      <View class="h-10 shrink-0 flex-row items-center gap-2 border-b border-border-60 px-3">
        <FileSurfaceAction label={selected() ? "Back to archive" : "Parent folder"} icon="chevron-left" disabled={!selected() && folder() === ""} onPress={() => { if (selected()) selected.set(null); else folder.set(archiveParentFolder(folder())); }} />
        <Text class="min-w-0 flex-1 truncate text-xs text-foreground">{selected() ?? (folder() || "Archive contents")}</Text>
        <Text class="shrink-0 text-xs text-muted-foreground">{`${group(props.archive.entries.length)} entries · ${formatByteLength(props.sizeBytes)}`}</Text>
      </View>
      {selected() ? <ArchiveEntryView archive={props.archive} path={selected()!} /> : (
        <View class="min-h-0 flex-1">
          <View class="h-8 shrink-0 flex-row items-center px-3" accessibilityLabel="Archive columns">
            <Text class="min-w-0 flex-1 text-xs text-muted-foreground">Name</Text>
            <Text class="w-20 shrink-0 text-right text-xs text-muted-foreground">Size</Text>
            <Text class="w-28 shrink-0 text-right text-xs text-muted-foreground">Modified</Text>
          </View>
          {rows().length === 0 ? <Text class="p-6 text-xs text-muted-foreground">This folder is empty.</Text> : (
            <List each={rows()} keyExtractor={(row) => `${row.path}${row.directory ? "/" : ""}`} class="min-h-0 flex-1" contentClass="pb-4" testID="Archive entries">
              {(row) => (
                <View role="button" accessibilityLabel={rowLabel(row())} onPress={() => { if (row().directory) folder.set(`${row().path}/`); else selected.set(row().path); }} class="h-9 flex-row items-center gap-2 border-b border-border-60 px-3 hover:bg-muted-40">
                  <HIcon name={row().directory ? "folder-closed" : "file"} size={16} />
                  <Text class="min-w-0 flex-1 truncate text-xs text-foreground">{rowLabel(row())}</Text>
                  <Text class="w-20 shrink-0 text-right text-xs text-muted-foreground">{formatByteLength(row().size)}</Text>
                  <Text class="w-28 shrink-0 text-right text-xs text-muted-foreground">{entryDate(row().modified)}</Text>
                </View>
              )}
            </List>
          )}
        </View>
      )}
    </View>
  );
}

function DatabaseBrowser(props: { db: OpenSqlite; sizeBytes: number }) {
  const table = signal(props.db.tables[0]?.name ?? "");
  const page = signal(0);
  const current = () => props.db.tables.find((item) => item.name === table());
  const result = computed((): { columns: string[]; rows: { id: string; cells: string[] }[]; error: string } => {
    const name = table();
    if (!name) return { columns: [], rows: [], error: "" };
    try {
      const read = props.db.rows(name, page());
      return { columns: read.columns, rows: read.rows.map((cells, index) => ({ id: JSON.stringify([name, page(), index]), cells })), error: "" };
    } catch (cause) {
      return { columns: [], rows: [], error: cause instanceof Error ? cause.message : "This table is unavailable." };
    }
  });
  const first = () => (current()?.count ?? 0) === 0 ? "0 rows" : `${page() * SQLITE_PAGE_SIZE + 1}–${Math.min(current()?.count ?? 0, (page() + 1) * SQLITE_PAGE_SIZE)} of ${group(current()?.count ?? 0)}`;
  const tableLabel = (item: { name: string; count: number }) => `${item.name} (${group(item.count)} rows)`;
  function pickTable(at: { x: number; y: number }) {
    void popupOverOverlay(props.db.tables.map((item) => ({ label: tableLabel(item), checked: item.name === table(), onSelect: () => { table.set(item.name); page.set(0); } })), at, "database table menu");
  }
  const cell = (text: string, width: number, strong: boolean) => (
    <View style={{ width }} class="shrink-0 border-r border-border-60 px-3 py-1.5"><Text class={`text-xs ${strong ? "font-medium" : ""} text-foreground`}>{text}</Text></View>
  );
  const widths = (columns: string[], rows: { cells: string[] }[]) => columns.map((name, index) => Math.min(320, Math.max(128, name.length * 8 + 24, ...rows.slice(0, 20).map((row) => (row.cells[index]?.length ?? 0) * 7 + 24))));
  const widthsNow = computed(() => widths(result().columns, result().rows));
  return (
    <View class="min-h-0 flex-1" accessibilityLabel="Database">
      {props.db.tables.length === 0 ? <Text class="p-6 text-xs text-muted-foreground">This database has no readable tables.</Text> : null}
      {props.db.tables.length === 0 ? null : (
      <View class="min-h-10 shrink-0 flex-row items-center gap-2 border-b border-border-60 px-3 py-1">
        <View role="button" accessibilityLabel="Table" onPress={(event) => pickTable({ x: event.pagePosition.x, y: event.pagePosition.y })} class="h-7 min-w-32 flex-1 flex-row items-center gap-2 rounded-lg border border-input px-2">
          <Text class="min-w-0 flex-1 truncate text-xs text-foreground">{current() ? tableLabel(current()!) : ""}</Text>
          <HIcon name="chevrons-up-down" size={12} />
        </View>
        <FileSurfaceAction label="Previous rows" icon="chevron-left" disabled={page() === 0} onPress={() => page.update((value) => value - 1)} />
        <Text class="shrink-0 text-xs text-foreground">{first()}</Text>
        <FileSurfaceAction label="Next rows" icon="chevron-right" disabled={(page() + 1) * SQLITE_PAGE_SIZE >= (current()?.count ?? 0)} onPress={() => page.update((value) => value + 1)} />
      </View>
      )}
      {props.db.tables.length === 0 ? null : <View class="shrink-0 border-b border-border-60 px-3 py-2"><Text class="text-xs text-muted-foreground">{`${group(current()?.count ?? 0)} rows · ${result().columns.length} columns · ${formatByteLength(props.sizeBytes)}`}</Text></View>}
      {props.db.tables.length === 0 ? null : <FileSurfaceNotice text="Read-only. Up to 50 columns and 1,024 characters per cell. Blob contents are omitted." />}
      {result().error ? <FileSurfaceFailure message={result().error} /> : null}
      {props.db.tables.length > 0 && !result().error && result().rows.length === 0 ? <Text class="p-6 text-xs text-muted-foreground">This table is empty.</Text> : null}
      {!result().error && result().rows.length > 0 ? (
        <Scroll horizontal class="min-h-0 flex-1" contentClass="min-h-0" accessibilityLabel={`${table()} rows`}>
          <View class="min-h-0 flex-1">
            <View class="flex-row border-b border-border-60 bg-background" accessibilityLabel="Table header">{result().columns.map((name, index) => cell(name, widthsNow()[index] ?? 128, true))}</View>
            <List each={result().rows} keyExtractor={(row) => row.id} class="min-h-0 flex-1" contentClass="pb-4" testID="Table rows">
              {(row) => <View class="flex-row border-b border-border-60" testID="Database row">{row().cells.map((text, index) => cell(text, widthsNow()[index] ?? 128, false))}</View>}
            </List>
          </View>
        </Scroll>
      ) : null}
    </View>
  );
}

export function BinaryView(props: { cwd: string; relativePath: string; kind: "archive" | "sqlite"; readBytes?: ReadBytes; onRetry?: () => void }) {
  const read = props.readBytes ?? readWorkspaceBytes;
  const state = signal<{ status: "loading" } | { status: "error"; message: string } | { status: "archive"; archive: OpenArchive; size: number } | { status: "sqlite"; db: OpenSqlite; size: number }>({ status: "loading" });
  let generation = 0;
  async function load() {
    const request = ++generation;
    state.set({ status: "loading" });
    try {
      const bytes = await read(props.cwd, props.relativePath, BINARY_PREVIEW_MAX_BYTES);
      if (request !== generation) return;
      const name = props.relativePath.slice(props.relativePath.lastIndexOf("/") + 1);
      state.set(props.kind === "sqlite" ? { status: "sqlite", db: openSqlite(bytes), size: bytes.length } : { status: "archive", archive: openArchive(name, bytes), size: bytes.length });
    } catch (cause) {
      if (request === generation) state.set({ status: "error", message: cause instanceof Error ? cause.message : "Could not read this file." });
    }
  }
  effect(() => {
    void props.cwd;
    void props.relativePath;
    void load();
    return () => { generation++; };
  });
  const archive = () => { const current = state(); return current.status === "archive" ? current : null; };
  const database = () => { const current = state(); return current.status === "sqlite" ? current : null; };
  const failure = () => { const current = state(); return current.status === "error" ? current.message : null; };
  return (
    <View class="min-h-0 flex-1">
      {state().status === "loading" ? <FileSurfaceLoading /> : null}
      {failure() !== null ? <FileSurfaceFailure message={failure()!} onRetry={() => { void load(); }} /> : null}
      {archive() ? <ArchiveBrowser archive={archive()!.archive} sizeBytes={archive()!.size} /> : null}
      {database() ? <DatabaseBrowser db={database()!.db} sizeBytes={database()!.size} /> : null}
    </View>
  );
}
