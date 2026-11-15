// A chat attachment opened as a right-panel tab (files/AttachmentFilePreview.tsx, surface id `attachment:<id>`): a strip with
// "Attachment", the name and size, then the file in the viewer its type calls for. The bytes come through the signed-asset reader the
// timeline's thumbnails use. PDFs and Open XML documents open in the reference's own viewers (DocumentViewer); fonts and rendered
// HTML are not drawn. Save file writes to Downloads (the app has no save dialog; the runtime writes at most 8 MB at once).
import { Clipboard, effect, Image, signal, Text, Video, View } from "nsh";
import { ChatMarkdown } from "../thread/markdown/ChatMarkdown";
import { readAttachment } from "../thread/readAttachment";
import { BinaryView } from "./BinaryView";
import { delimiterOf } from "./delimited";
import { DelimitedTableView } from "./FileViewers";
import { FileSurfaceAction, FileSurfaceFailure, FileSurfaceLoading, FileSurfaceNotice, FILE_SURFACE_SUBHEADER_CLASS } from "./fileSurfaceChrome";
import { filePreviewKind, renderedToggleLabel, showsRawText, type FilePreviewKind } from "./filePreviewKind";
import { formatByteLength } from "./filesLogic";
import { officeFormat } from "./officeDocs";
import { OfficeView } from "./OfficeView";
import { DocumentViewer } from "./DocumentViewer";
import { writeFile } from "fs/promises";
import { homedir } from "os";
import { showToast } from "../toast";
import { MermaidFileView } from "./RenderedViews";
import { SourceView } from "./SourceView";
import { decodePreviewText } from "./workspaceBytes";
import { defaultWordWrap } from "../thread/markdown/MarkdownCodeBlock";

export interface AttachmentFile { id: string; name: string; mimeType: string; sizeBytes: number }
type Load = (attachmentId: string, options: { signal: AbortSignal; maxBytes: number }) => Promise<Blob>;

export const ATTACHMENT_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

/** The viewer an attachment gets: its name's kind, else what its MIME type says. */
export function attachmentKind(file: Pick<AttachmentFile, "name" | "mimeType">): FilePreviewKind | "unsupported" {
  const named = filePreviewKind(file.name);
  if (named !== "text" || /\.[A-Za-z0-9]+$/.test(file.name)) {
    if (named !== "text") return named;
    if (/\.(?:txt|log|json|jsonc|ya?ml|toml|ini|xml|css|[cm]?[jt]sx?|py|rb|go|rs|sh|sql|diff|patch)$/i.test(file.name)) return "text";
  }
  const mime = file.mimeType.split(";")[0]!.trim().toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "text/html") return "html";
  if (mime === "text/markdown") return "markdown";
  if (mime === "text/csv" || mime === "text/tab-separated-values") return "table";
  if (mime.startsWith("text/") || /json|xml|yaml|toml|javascript|sql/.test(mime)) return "text";
  return "unsupported";
}

export function AttachmentFileView(props: {
  attachment: AttachmentFile;
  load?: Load;
  /** The label before the name ("Attachment" by default; a composer draft's file reads "Draft"). */
  origin?: string;
  /** A draft's file: "Remove from draft". */
  onRemove?: () => void;
  /** A dialog's "Close". */
  onClose?: () => void;
}) {
  const load = props.load ?? readAttachment;
  const bytes = signal<Uint8Array | null>(null);
  const error = signal("");
  const copied = signal(false);
  const wrapOverride = signal<boolean | null>(null);
  const rendered = signal(true);
  const retry = signal(0);
  const imageUrl = signal("");
  const mediaUrl = signal("");
  const kind = () => attachmentKind(props.attachment);
  const wrap = () => wrapOverride() ?? defaultWordWrap();
  effect(() => {
    const file = props.attachment;
    void retry();
    bytes.set(null);
    error.set("");
    rendered.set(true);
    imageUrl.set("");
    mediaUrl.set("");
    if (kind() === "unsupported") return;
    if (!Number.isFinite(file.sizeBytes) || file.sizeBytes > ATTACHMENT_PREVIEW_MAX_BYTES) { error.set("Preview limited to files under 50 MB."); return; }
    const controller = new AbortController();
    let live = true;
    let url = "";
    void load(file.id, { signal: controller.signal, maxBytes: ATTACHMENT_PREVIEW_MAX_BYTES }).then(async (blob) => {
      if (!live) return;
      const data = new Uint8Array(await blob.arrayBuffer());
      if (kind() === "image") { url = URL.createObjectURL(new Blob([data], { type: file.mimeType })); imageUrl.set(url); }
      if (kind() === "video" || kind() === "audio") { url = URL.createObjectURL(new Blob([data], { type: file.mimeType })); mediaUrl.set(url); }
      bytes.set(data);
    }).catch((cause: unknown) => { if (live && !controller.signal.aborted) error.set(cause instanceof Error ? cause.message : "The attachment is unavailable."); });
    return () => { live = false; controller.abort(); if (url) URL.revokeObjectURL(url); };
  });
  const text = () => {
    const data = bytes();
    if (!data || !(kind() === "text" || kind() === "markdown" || kind() === "table" || kind() === "mermaid" || kind() === "html" || kind() === "notebook")) return null;
    try { return decodePreviewText(data); } catch (cause) { return { text: "", truncated: false, error: cause instanceof Error ? cause.message : "Unable to load file preview." }; }
  };
  const textError = () => { const current = text(); return current && "error" in current ? (current as { error: string }).error : ""; };
  const toggleMode = (): "markdown" | "mermaid" | "table" | null => { const mode = kind() as FilePreviewKind; return mode === "markdown" || mode === "mermaid" || mode === "table" ? mode : null; };
  const readBytes = async () => bytes() ?? new Uint8Array();
  const unsupported = () => kind() === "unsupported" || kind() === "font" || kind() === "notebook";
  const openXml = () => { const format = officeFormat(props.attachment.name); return format === "docx" || format === "xlsx" || format === "pptx" ? format : null; };
  // AttachmentFilePreview's Save file: the browser downloads it; the app writes it to Downloads.
  const saving = signal(false);
  async function save() {
    const data = bytes();
    if (!data || saving()) return;
    saving.set(true);
    try {
      await writeFile(`${homedir()}/Downloads/${props.attachment.name.replace(/[\\/]/g, "_")}`, data);
    } catch (cause) {
      showToast({ type: "error", title: "Could not save file", description: cause instanceof Error ? cause.message : "Please try again." });
    } finally {
      saving.set(false);
    }
  }
  const showRaw = () => text() !== null && !textError() && (kind() === "text" || kind() === "html" || kind() === "notebook" || !rendered());
  return (
    <View class="min-h-0 flex-1 bg-background" accessibilityLabel={`Attachment ${props.attachment.name}`}>
      <View class={FILE_SURFACE_SUBHEADER_CLASS}>
        <View class="min-w-0 flex-1 flex-row items-center gap-1">
          <Text class="shrink-0 px-0.5 text-xs text-muted-foreground">{props.origin ?? "Attachment"}</Text>
          <Text class="min-w-0 truncate px-0.5 text-xs font-medium text-foreground" accessibilityLabel={props.attachment.name}>{props.attachment.name}</Text>
          {props.attachment.sizeBytes > 0 ? <Text class="ml-2 shrink-0 text-xs text-muted-foreground">{formatByteLength(props.attachment.sizeBytes)}</Text> : null}
        </View>
        {toggleMode() ? <FileSurfaceAction label={renderedToggleLabel(toggleMode()!, rendered())} icon={rendered() ? "code" : toggleMode() === "table" ? "table-2" : "eye"} pressed={rendered()} onPress={() => rendered.update((value) => !value)} /> : null}
        {text() && showsRawText(kind() as FilePreviewKind, rendered()) ? <FileSurfaceAction label={wrap() ? "Disable word wrap" : "Enable word wrap"} icon="text-wrap" pressed={wrap()} onPress={() => wrapOverride.set(!wrap())} /> : null}
        {text() ? <FileSurfaceAction label={copied() ? "Copied" : text()!.truncated ? "Copy preview" : "Copy contents"} icon={copied() ? "check" : "copy"} onPress={() => { void Clipboard.writeText(text()!.text).then(() => { copied.set(true); setTimeout(() => copied.set(false), 1500); }).catch((cause: unknown) => showToast({ type: "error", title: "Could not copy file", description: cause instanceof Error ? cause.message : "Try again." })); }} /> : null}
        {bytes() ? <FileSurfaceAction label={saving() ? "Preparing file…" : "Save file"} icon="download" disabled={saving()} onPress={() => void save()} /> : null}
        {props.onRemove ? <FileSurfaceAction label="Remove from draft" icon="trash-2" onPress={props.onRemove} /> : null}
        {props.onClose ? <FileSurfaceAction label="Close" icon="x" onPress={props.onClose} /> : null}
      </View>
      {text()?.truncated ? <FileSurfaceNotice text={`Preview limited to the first 1 MB${props.attachment.sizeBytes > 0 ? ` of a ${String(props.attachment.sizeBytes).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} byte file` : ""}.`} /> : null}
      {unsupported() ? (
        <View class="min-h-0 flex-1 items-center justify-center gap-1 px-6">
          <Text class="text-center text-sm font-medium text-foreground">No preview for this file</Text>
          <Text class="max-w-sm text-center text-xs leading-relaxed text-muted-foreground">{`Open it in an app that supports ${props.attachment.name.split(".").pop() || "this format"} files.`}</Text>
        </View>
      ) : null}
      {error() ? <FileSurfaceFailure message={error()} onRetry={() => retry.update((value) => value + 1)} /> : null}
      {textError() ? <FileSurfaceFailure message={textError()} /> : null}
      {!unsupported() && !error() && bytes() === null ? <FileSurfaceLoading /> : null}
      {kind() === "image" && imageUrl() ? <View class="min-h-0 flex-1 items-center justify-center p-4" accessibilityLabel="Image preview"><Image src={imageUrl()} accessibilityLabel={props.attachment.name} onError={() => error.set("Unable to load image.")} class="max-h-full max-w-full" style={{ objectFit: "contain" }} /></View> : null}
      {(kind() === "video" || kind() === "audio") && mediaUrl() ? <View class="min-h-0 flex-1 items-center justify-center bg-black"><Video src={mediaUrl()} controls paused class="h-full w-full" accessibilityLabel={props.attachment.name} onError={() => error.set(kind() === "video" ? "Unable to load video." : "Unable to load audio.")} /></View> : null}
      {(kind() === "archive" || kind() === "sqlite") && bytes() ? <BinaryView cwd="" relativePath={props.attachment.name} kind={kind() as "archive" | "sqlite"} readBytes={readBytes} /> : null}
      {kind() === "pdf" && bytes() ? <DocumentViewer kind="pdf" cwd="" relativePath={props.attachment.name} readBytes={readBytes} /> : null}
      {kind() === "office" && bytes() && openXml() ? <DocumentViewer kind={openXml()!} cwd="" relativePath={props.attachment.name} readBytes={readBytes} /> : null}
      {kind() === "office" && bytes() && officeFormat(props.attachment.name) && !openXml() ? <OfficeView cwd="" relativePath={props.attachment.name} format={officeFormat(props.attachment.name)!} readBytes={readBytes} /> : null}
      {text() && !textError() && kind() === "table" && rendered() ? <DelimitedTableView text={text()!.text} delimiter={delimiterOf(props.attachment.name)} wrap={wrap} /> : null}
      {text() && !textError() && kind() === "mermaid" && rendered() ? <MermaidFileView text={text()!.text} /> : null}
      {text() && !textError() && kind() === "markdown" && rendered() ? <View class="min-h-0 flex-1 px-6 py-4" testID="Rendered markdown"><ChatMarkdown text={() => text()!.text} /></View> : null}
      {showRaw() ? <SourceView name={props.attachment.name} text={text()!.text} wrap={wrap} testID="Attachment source" /> : null}
    </View>
  );
}
