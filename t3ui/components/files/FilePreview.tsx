// A file opened from the Files browser (FilePreviewPanel.tsx): breadcrumbs and a
// read-only, line-numbered source view read through `projects.readFile`.
import { effect, Image, keymap, List, Scroll, signal, Storage, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";
import { attachExtraContext, type ExtraContextRecord } from "../composer/contextChips";
import { fileReviewCommentRecord, formatFileCommentRange, nextFileCommentId, type FileComment } from "./fileComments";
import type { ListRef } from "nsh";
import { openThread, requestBackend } from "../../store";
import { defaultWordWrap } from "../thread/markdown/MarkdownCodeBlock";
import { HIcon } from "../header/HeaderIcons";
import { highlightCode, resolveLanguage, tokenClass, type HighlightToken } from "../thread/markdown/highlight";
import { revealIndex } from "./fileLineReveal";
import { ChatMarkdown } from "../thread/markdown/ChatMarkdown";
import { formatByteLength, previewLines, readFileContents, readFileFailureMessage, workspaceFileUrl } from "./filesLogic";
import { filePreviewKind, hasRenderedMode, hostedInWebView, readsAsText, renderedToggleLabel, showsRawText, viewedNatively } from "./filePreviewKind";
import { delimiterOf } from "./delimited";
import { DelimitedTableView, HostedFileView, NotebookView, UnsupportedFileView } from "./FileViewers";
import { FileBreadcrumbs } from "./FileBreadcrumbs";
import { canOpenFileInPreview, openFileInPreviewBrowser } from "../browser/previewOpeners";
import { currentWorkspace } from "../rightPanel/panelState";
import { openInPreferredEditor, runFileActionWithFeedback, showFileMenu } from "./fileActionsRuntime";
import { absoluteFilePath } from "./fileActions";
import { ImagePreview } from "./ImagePreview";
import { readWorkspaceBytes } from "./workspaceBytes";
import { DocumentViewer } from "./DocumentViewer";
import { AudioFileView } from "./RenderedViews";
import { isLocalServer } from "../composer/folderDrop";
import { backendUrl } from "../../store";
import { createStableRows } from "../stableRows";
import { measureInto, type PageRect } from "../rightPanel/nativeOcclusion";
import { BinaryView } from "./BinaryView";
import { fileAccessBlockedText, filesystemReadAccess } from "./fileAccess";
import { explorerOpen, isHostPath, shouldShowFileExplorer, toggleExplorer } from "./explorerState";
import { FileEditor } from "./FileEditor";
import { FileExplorerPane } from "./FileExplorerPane";
import { filesystemAccess, refreshFilesystemAccess, setFileSaveWriter, unsavedDraft } from "./fileSaveRuntime";
import { FilesPanel } from "./FilesPanel";
import { FileSurfaceAction, FileSurfaceNotice } from "./fileSurfaceChrome";
import { LargeTextView } from "./LargeTextView";
import { OfficeView } from "./OfficeView";
import { MermaidFileView, VideoFileView } from "./RenderedViews";
import { officeFormat } from "./officeDocs";
import { retainedBreadcrumbTrail as retainedTrail, trailChildOf } from "./folderTrail";
import { useWorkspaceMutationRefresh } from "../coordinators/liveRefresh";
import { workspaceMutationId } from "../../store";

export interface FilePreviewProps {
  cwd: string;
  relativePath: string;
  projectName?: string | null;
  /** One-based line to reveal and highlight once the file is shown (fileLineReveal.ts). */
  line?: number | undefined;
  /** Opens another file (the breadcrumb menus' file rows). */
  onOpenFile?: (relativePath: string) => void;
  request?: (method: string, payload: unknown) => Promise<unknown>;
  /** The right panel's file tab: the side explorer, the folder trail and the unsaved-file marker (FilePreviewPanel's tab). */
  explorer?: boolean | undefined;
  /** Where the tab's folder state goes: a crumb opens its folder in this tab (the reference's navigateFolder). */
  onNavigateFolder?: ((relativePath: string, folderTrail: string, keepSource: boolean) => void) | undefined;
  /** The deepest path kept after moving up with the breadcrumbs, so the way back down stays shown. */
  folderTrail?: string | undefined;
  onPendingChange?: ((relativePath: string, pending: boolean) => void) | undefined;
  /** Whether this session may write files; the connection's `filesystem:write` scope when omitted. */
  canWrite?: (() => boolean) | undefined;
  /** Whether the whole file can be read from this machine's disk (a local environment); decides the full-file view of a large file. */
  fullFileAvailable?: (() => boolean) | undefined;
  /** Test seam for the viewers that read the file's bytes. */
  readBytes?: ((cwd: string, relativePath: string, maxBytes: number) => Promise<Uint8Array>) | undefined;
}

/** FilePreviewPanel's rendered/source choices outlive the file (useLocalStorage, default rendered):
 * t3code.renderMarkdown, t3code.renderMermaid, t3code.renderBrowserFile (HTML), t3code.renderTable. */
const RENDER_KEYS = { markdown: "t3code.renderMarkdown", mermaid: "t3code.renderMermaid", html: "t3code.renderBrowserFile", table: "t3code.renderTable" } as const;
type RenderKind = keyof typeof RENDER_KEYS;
const renderPreferred = signal<Record<RenderKind, boolean>>({ markdown: true, mermaid: true, html: true, table: true });
const renderChosen = new Set<RenderKind>();
for (const kind of Object.keys(RENDER_KEYS) as RenderKind[]) {
  void Storage.getItem(RENDER_KEYS[kind]).then((text) => {
    if (renderChosen.has(kind) || (text !== "true" && text !== "false")) return;
    renderPreferred.update((all) => ({ ...all, [kind]: text === "true" }));
  }).catch(() => {});
}
export function setRenderPreferred(kind: RenderKind, value: boolean) {
  renderChosen.add(kind);
  renderPreferred.update((all) => ({ ...all, [kind]: value }));
  void Storage.setItem(RENDER_KEYS[kind], value ? "true" : "false").catch(() => {});
}

export function FilePreview(props: FilePreviewProps) {
  const rpc = props.request ?? requestBackend;
  // FilePreviewPanel's access gate (useFilesystemReadAccess); a caller-supplied reader (tests, fixtures) is not gated.
  const accessBlocked = () => (props.request ? null : fileAccessBlockedText(filesystemReadAccess()));
  const state = signal<"loading" | "ready" | "error">("loading");
  // A file the server will not read as text (ProjectReadFileError binary_file) opens in the unavailable state, not as an error.
  const binary = signal(false);
  const hostedFailure = signal("");
  const actionFailure = signal("");
  // The Word wrap setting is the default; the toggle overrides it for this file (FilePreviewPanel's wordWrapOverride).
  const wrapOverride = signal<boolean | null>(null);
  const wrap = () => wrapOverride() ?? defaultWordWrap();
  const kind = () => filePreviewKind(props.relativePath);
  const lines = signal<{ id: string; n: number; text: string; tokens: HighlightToken[] }[]>([]);
  const stableLines = createStableRows<{ id: string; n: number; text: string; tokens: HighlightToken[] }>((line) => line.id);
  const list = signal<ListRef | null>(null);
  const byteLength = signal(0);
  const truncated = signal(false);
  const error = signal("");
  const source = signal("");
  // Markdown opens rendered, unless a line was asked for: that needs the source's lines.
  const rendered = signal(props.line === undefined && renderPreferred().markdown);
  const imageFailed = signal(false);
  const isImage = () => kind() === "image";
  const canRender = () => kind() === "markdown";
  // Tables render as a grid first, notebooks always render; the toggle on a table shows its source.
  const tableRendered = signal(props.line === undefined && renderPreferred().table);
  // Mermaid and HTML files open rendered, like tables, unless a line was asked for (it needs the source's lines).
  const mermaidRendered = signal(props.line === undefined && renderPreferred().mermaid);
  const htmlRendered = signal(props.line === undefined && renderPreferred().html);
  // A path the server says is a folder (ProjectReadFileError path_not_file) is a folder tab: the explorer fills it.
  const folder = signal(false);
  const rowRect = signal<PageRect | null>(null);
  let rowHost: { measure(): Promise<any> } | undefined;
  let generation = 0;
  effect(() => { refreshFilesystemAccess(); });
  if (props.request) setFileSaveWriter(props.request);

  async function load() {
    const request = ++generation;
    imageFailed.set(false);
    binary.set(false);
    hostedFailure.set("");
    wrapOverride.set(null);
    tableRendered.set(true);
    mermaidRendered.set(props.line === undefined);
    htmlRendered.set(props.line === undefined);
    folder.set(false);
    // Images, PDFs, audio, fonts and the formats with no viewer open from the file itself, not as text.
    if (isImage() || !readsAsText(kind())) { state.set("ready"); lines.set([]); truncated.set(false); return; }
    state.set("loading");
    try {
      const file = readFileContents(await rpc("projects.readFile", { cwd: props.cwd, relativePath: props.relativePath }));
      if (request !== generation) return;
      const texts = previewLines(file.contents);
      const tokens = highlightCode(texts.join("\n"), resolveLanguage(props.relativePath));
      // resolveProjectFileQueryData: an unsaved draft (a failed or not-yet-allowed write) shows over the file's read.
      source.set(untracked(() => unsavedDraft({ cwd: props.cwd, relativePath: props.relativePath })) ?? file.contents);
      lines.set(stableLines(JSON.stringify([props.cwd, props.relativePath]), texts.map((text, index) => ({ id: String(index), n: index + 1, text, tokens: tokens[index] ?? [] }))));
      byteLength.set(file.byteLength);
      truncated.set(file.truncated);
      state.set("ready");
    } catch (cause) {
      if (request !== generation) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      error.set(readFileFailureMessage(message));
      binary.set(/binary/i.test(message));
      folder.set(/path_not_file|directory or special file|not a regular file/i.test(message));
      state.set("error");
    }
  }

  effect(() => {
    void props.cwd;
    void props.relativePath;
    void load();
    return () => { generation++; };
  });
  // Another surface on the same file edited it: this one shows the same draft (the shared optimistic file).
  effect(() => {
    const draft = unsavedDraft({ cwd: props.cwd, relativePath: props.relativePath });
    if (draft !== null && untracked(() => state() === "ready" && source() !== draft)) source.set(draft);
  });

  // The line a palette or link asked for is scrolled to the middle of the view.
  effect(() => {
    const index = revealIndex(props.line, lines().length);
    const current = list();
    if (index === null || !current || state() !== "ready") return;
    const frame = requestAnimationFrame(() => current.scrollToIndex({ index, animated: false, viewPosition: 0.5 }));
    return () => cancelAnimationFrame(frame);
  });

  // The source view: plain text, or markdown / a table while shown as source.
  const isFolder = () => folder() || (props.folderTrail !== undefined && state() === "loading");
  const hostFile = () => isHostPath(props.relativePath);
  const canWriteFiles = () => (props.canWrite ? props.canWrite() : filesystemAccess() === "writable");
  const readOnlyConnection = () => !hostFile() && (props.canWrite ? !props.canWrite() : filesystemAccess() === "readonly");
  const fullFileAvailable = () => (props.fullFileAvailable ? props.fullFileAvailable() : isLocalServer(backendUrl()));
  const renderedNow = () => (kind() === "markdown" ? rendered() : kind() === "table" ? tableRendered() : kind() === "mermaid" ? mermaidRendered() : kind() === "html" ? htmlRendered() : false);
  // A file the read cut short opens in full from disk (LargeTextViewer), except the kinds rendered from their text.
  const largeText = () => state() === "ready" && truncated() && fullFileAvailable() && (kind() === "text" || kind() === "table");
  const sourceVisible = () => state() === "ready" && !isImage() && readsAsText(kind()) && kind() !== "notebook" && !renderedNow() && !largeText();
  // Writable, whole, workspace text is edited in place; the rest is read-only (EditableFileSurface vs SourceFilePreview).
  const editable = () => sourceVisible() && !truncated() && !hostFile() && canWriteFiles();
  // FilePreviewPanel's workspaceMutationId revision (minimal hook, shell-stores fix): a read-only text view re-reads after the
  // agent may have changed the workspace. An editable view keeps the user's text (FileEditor owns its own save state).
  useWorkspaceMutationRefresh({ enabled: () => !editable(), mutationId: () => workspaceMutationId(), refresh: () => { if (state() === "ready" && readsAsText(kind()) && !isImage()) void reloadContents(); }, resourceKey: () => `file:${props.cwd}:${props.relativePath}` });
  /** The text again, in place: the view's own toggles (rendered, wrap, table) stay as the user left them. */
  async function reloadContents() {
    const request = ++generation;
    try {
      const file = readFileContents(await rpc("projects.readFile", { cwd: props.cwd, relativePath: props.relativePath }));
      if (request !== generation) return;
      const texts = previewLines(file.contents);
      const tokens = highlightCode(texts.join("\n"), resolveLanguage(props.relativePath));
      source.set(file.contents);
      lines.set(stableLines(JSON.stringify([props.cwd, props.relativePath]), texts.map((text, index) => ({ id: String(index), n: index + 1, text, tokens: tokens[index] ?? [] }))));
      byteLength.set(file.byteLength);
      truncated.set(file.truncated);
    } catch { /* the shown text stays; the next mutation or a reopen reads again */ }
  }
  const gutter = () => Math.max(3, String(lines().length).length) * 8 + 16;
  const target = () => ({ cwd: props.cwd, relativePath: props.relativePath, kind: "file" as const });
  const fail = (message: string) => actionFailure.set(message);
  // FilePreviewPanel's line comments (fileCommentAnnotations): a gutter press opens a draft under the line, saving it adds
  // a "File comment" record to the open thread's composer and keeps it under its lines; Mod+Enter submits.
  const fileComments = signal<FileComment[]>([]);
  const draft = signal<{ startLine: number; endLine: number } | null>(null);
  const draftText = signal("");
  const draftFocused = signal(false);
  let anchorLine: number | null = null;
  const inDraft = (n: number) => { const current = draft(); return current !== null && n >= current.startLine && n <= current.endLine; };
  function startComment(n: number, extend: boolean) {
    const from = extend && anchorLine !== null ? anchorLine : n;
    anchorLine = from;
    draft.set({ startLine: Math.min(from, n), endLine: Math.max(from, n) });
    draftText.set("");
  }
  function saveComment() {
    const current = draft();
    const text = draftText().trim();
    if (!current || !text) return;
    const comment: FileComment = { id: nextFileCommentId(), ...current, text };
    fileComments.update((all) => [...all, comment]);
    const thread = openThread();
    if (thread) attachExtraContext(thread.id, fileReviewCommentRecord(comment, props.relativePath, source()) as unknown as ExtraContextRecord);
    draft.set(null);
    draftText.set("");
  }
  function deleteComment(id: string) { fileComments.update((all) => all.filter((comment) => comment.id !== id)); }
  effect(() => {
    if (!draftFocused() || !draft()) return;
    return keymap.bind("mod+enter", () => { if (draftText().trim().length > 0) saveComment(); }, { when: "always" });
  });
  async function openInEditor() {
    // useOpenInPreferredEditor: refused without the operate scope, a failure when no editor is installed.
    try { await openInPreferredEditor(absoluteFilePath(props.cwd, props.relativePath), rpc); actionFailure.set(""); }
    catch (cause) { fail(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function reveal() {
    // The toast ("Unable to reveal file" with the path) is raised by runFileActionWithFeedback.
    await runFileActionWithFeedback({ id: "reveal" }, target(), rpc);
  }
  const wrapsToggle = () => showsRawText(kind(), renderedNow()) && !editable();
  const showUnsupported = () => (state() === "ready" && !isImage() && !readsAsText(kind()) && !hostedInWebView(kind()) && !viewedNatively(kind())) || (state() === "error" && binary() && !folder());
  const toggleRendered = () => {
    const mode = kind();
    if (mode === "markdown") { rendered.update((value) => !value); setRenderPreferred("markdown", rendered()); }
    else if (mode === "table") { tableRendered.update((value) => !value); setRenderPreferred("table", tableRendered()); }
    else if (mode === "mermaid") { mermaidRendered.update((value) => !value); setRenderPreferred("mermaid", mermaidRendered()); }
    else if (mode === "html") { htmlRendered.update((value) => !value); setRenderPreferred("html", htmlRendered()); }
  };
  // OpenXmlOfficeViewer's kinds draw in the reference's own viewer page; ODF and EPUB keep the native reader.
  const openXmlKind = () => { const format = officeFormat(props.relativePath); return format === "docx" || format === "xlsx" || format === "pptx" ? format : null; };
  const showExplorer = () => props.explorer === true && !isFolder() && shouldShowFileExplorer({ relativePath: props.relativePath, explorerOpen: explorerOpen(), attachmentOpen: false });
  const trail = () => props.folderTrail ?? props.relativePath;
  // A folder tab highlights the entry the trail leads down to (trailChildOf), else the folder itself in the workspace tree.
  const folderSelected = () => {
    const child = props.folderTrail ? trailChildOf(props.relativePath, props.folderTrail) : null;
    if (hostFile()) return child ? `${props.relativePath.replace(/[\\/]+$/, "")}/${child}`.slice(props.relativePath.replace(/[\\/]+$/, "").length + 1) : null;
    return child ? (props.relativePath ? `${props.relativePath}/${child}` : child) : props.relativePath;
  };
  const headerButton = (label: string, icon: string, pressed: boolean | undefined, onPress: () => void) => (
    <View role="button" accessibilityLabel={label} accessibilityState={pressed === undefined ? {} : { pressed }} onPress={onPress} class={`size-7 items-center justify-center rounded-lg ${pressed ? "bg-accent" : "hover:bg-accent"}`}>
      <HIcon name={icon} size={14} />
    </View>
  );

  return (
    <View class="min-h-0 flex-1 bg-background" accessibilityLabel={`File ${props.relativePath}`} onContextMenu={(event) => void showFileMenu(target(), event.pagePosition, () => {}, rpc)}>
      <View class="h-9 shrink-0 flex-row items-center gap-1 px-3">
        <FileBreadcrumbs cwd={props.cwd} projectName={props.projectName ?? "Project"} relativePath={props.relativePath} trail={trail()} onOpenFile={(path) => props.onOpenFile?.(path)} {...(props.onNavigateFolder ? { onNavigateFolder: (path: string) => props.onNavigateFolder?.(path, retainedTrail(props.folderTrail, path), !isFolder()) } : {})} request={rpc} />
        <View class="flex-1" />
        {state() === "ready" && readsAsText(kind()) ? <Text class="text-2xs text-muted-foreground">{formatByteLength(byteLength())}</Text> : null}
        {state() === "ready" && hasRenderedMode(kind()) && !isFolder() ? <FileSurfaceAction label={renderedToggleLabel(kind() as "markdown" | "mermaid" | "html" | "table", renderedNow())} icon={renderedNow() ? "code" : kind() === "table" ? "table-2" : "eye"} pressed={renderedNow()} onPress={toggleRendered} /> : null}
        {state() === "ready" && wrapsToggle() ? headerButton(wrap() ? "Disable word wrap" : "Enable word wrap", "text-wrap", wrap(), () => wrapOverride.set(!wrap())) : null}
        {canOpenFileInPreview(props.relativePath) ? headerButton("Open file in preview browser", "globe", undefined, () => { const threadId = currentWorkspace()?.threadId; if (threadId) void openFileInPreviewBrowser({ threadId, cwd: props.cwd, relativePath: props.relativePath }); }) : null}
        {props.explorer === true && !hostFile() && !isFolder() ? <FileSurfaceAction label={explorerOpen() ? "Hide file explorer" : "Show file explorer"} icon="folder-tree" pressed={explorerOpen()} onPress={toggleExplorer} /> : null}
      </View>
      {readOnlyConnection() ? <View class="shrink-0 border-b border-border-60 px-3 py-1.5"><Text class="text-2xs text-muted-foreground">Read-only connection. Unsaved edits are kept until write access returns.</Text></View> : null}
      {state() === "ready" && truncated() && !largeText() && (kind() === "markdown" || kind() === "mermaid" || (kind() === "html" && !htmlRendered())) ? <FileSurfaceNotice text={`Preview limited to the first 1 MB of a ${String(byteLength()).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} byte file.`} /> : null}
      {accessBlocked() ? (
        accessBlocked() === "Checking file access..."
          ? <View class="min-h-0 flex-1 flex-row items-center justify-center gap-2" accessibilityLabel="Checking file access"><Text class="text-sm text-muted-foreground">Checking file access...</Text></View>
          : <View class="p-4"><Text class="text-sm text-muted-foreground">{accessBlocked()}</Text></View>
      ) : null}
      <View ref={(node: any) => { rowHost = node; }} onLayout={() => measureInto(rowHost, rowRect)} class={`min-h-0 flex-1 flex-row ${accessBlocked() ? "hidden" : ""}`}>
      {isFolder() ? <View class="min-h-0 min-w-0 flex-1" accessibilityLabel="Folder"><FilesPanel cwd={hostFile() ? props.relativePath : props.cwd} projectName={hostFile() ? props.relativePath : (props.projectName ?? "Project")} selectedPath={folderSelected} onOpenFile={(path) => props.onOpenFile?.(hostFile() ? `${props.relativePath.replace(/[\\/]+$/, "")}/${path}` : path)} request={rpc} /></View> : null}
      <View class={`min-h-0 min-w-0 flex-1 ${isFolder() ? "hidden" : ""}`}>
      {actionFailure() ? <Text class="px-3 py-1 text-xs text-destructive" role="alert">{actionFailure()}</Text> : null}
      {state() === "loading" ? <Text class="px-3 py-1 text-xs text-muted-foreground">Loading file…</Text> : null}
      {state() === "error" && !binary() ? (
        <View class="gap-2 p-4">
          <Text class="text-xs text-destructive" role="alert">{error()}</Text>
          {/* FilePreviewPanel's failure: the path the read tried, selectable. */}
          <View class="gap-0.5" selectable>
            <Text class="text-xs text-muted-foreground">Attempted path</Text>
            <Text class="font-mono text-xs text-foreground">{hostFile() ? props.relativePath : absoluteFilePath(props.cwd, props.relativePath)}</Text>
          </View>
          <View accessibilityLabel="Retry loading file" role="button" onPress={() => void load()} class="self-start rounded-md border border-border px-3 py-1.5"><Text class="text-xs text-foreground">Retry</Text></View>
        </View>
      ) : null}
      {showUnsupported() ? <UnsupportedFileView kind={kind()} {...(state() === "error" ? { message: error() } : {})} canOpen onOpen={() => void openInEditor()} onReveal={() => void reveal()} /> : null}
      {state() === "ready" && hostedInWebView(kind()) ? (
        hostedFailure()
          ? <UnsupportedFileView kind={kind()} message={hostedFailure()} canOpen onOpen={() => void openInEditor()} onReveal={() => void reveal()} />
          : kind() === "pdf" ? <DocumentViewer kind="pdf" cwd={props.cwd} relativePath={props.relativePath} {...(props.readBytes ? { readBytes: props.readBytes } : {})} />
          : kind() === "audio" ? <AudioFileView cwd={props.cwd} relativePath={props.relativePath} {...(props.readBytes ? { readBytes: props.readBytes } : {})} />
          : <HostedFileView kind={kind() as "pdf" | "audio" | "font"} cwd={props.cwd} relativePath={props.relativePath} onFailure={(message) => hostedFailure.set(message)} {...(props.readBytes ? { readBytes: props.readBytes } : {})} />
      ) : null}
      {isImage() ? (
        <ImagePreview load={() => (props.readBytes ?? readWorkspaceBytes)(props.cwd, props.relativePath, 50 * 1024 * 1024)} name={props.relativePath} onError={() => imageFailed.set(true)} />
      ) : null}
      {state() === "ready" && kind() === "video" ? <VideoFileView cwd={props.cwd} relativePath={props.relativePath} {...(props.readBytes ? { readBytes: props.readBytes } : {})} /> : null}
      {state() === "ready" && (kind() === "archive" || kind() === "sqlite") ? <BinaryView cwd={props.cwd} relativePath={props.relativePath} kind={kind() as "archive" | "sqlite"} {...(props.readBytes ? { readBytes: props.readBytes } : {})} /> : null}
      {state() === "ready" && kind() === "office" && openXmlKind() ? <DocumentViewer kind={openXmlKind()!} cwd={props.cwd} relativePath={props.relativePath} {...(props.readBytes ? { readBytes: props.readBytes } : {})} /> : null}
      {state() === "ready" && kind() === "office" && officeFormat(props.relativePath) && !openXmlKind() ? <OfficeView cwd={props.cwd} relativePath={props.relativePath} format={officeFormat(props.relativePath)!} {...(props.readBytes ? { readBytes: props.readBytes } : {})} /> : null}
      {state() === "ready" && kind() === "mermaid" && mermaidRendered() ? <MermaidFileView text={source()} /> : null}
      {state() === "ready" && kind() === "html" && htmlRendered() ? <HostedFileView kind="html" cwd={props.cwd} relativePath={props.relativePath} onFailure={(message) => hostedFailure.set(message)} {...(props.readBytes ? { readBytes: props.readBytes } : {})} /> : null}
      {largeText() ? <LargeTextView cwd={props.cwd} relativePath={props.relativePath} delimiter={kind() === "table" && tableRendered() ? delimiterOf(props.relativePath) : null} line={props.line} wrap={wrap} {...(props.readBytes ? { readBytes: props.readBytes } : {})} /> : null}
      {editable() ? <FileEditor cwd={props.cwd} relativePath={props.relativePath} value={source} onInput={(text) => source.set(text)} line={props.line} onPendingChange={props.onPendingChange} /> : null}
      {state() === "ready" && kind() === "notebook" ? <NotebookView text={source()} /> : null}
      {state() === "ready" && kind() === "table" && tableRendered() && !largeText() ? <DelimitedTableView text={source()} delimiter={delimiterOf(props.relativePath)} wrap={wrap} /> : null}
      {state() === "ready" && !isImage() && canRender() && rendered() ? (
        <Scroll class="min-h-0 flex-1" contentClass="px-6 py-4" testID="Rendered markdown"><ChatMarkdown text={() => source()} /></Scroll>
      ) : null}
      {sourceVisible() && !editable() && lines().length === 0 ? <Text class="px-3 py-4 text-xs text-muted-foreground">This file is empty.</Text> : null}
      {sourceVisible() && !editable() && lines().length > 0 ? (
        <List ref={(node) => list.set(node)} each={lines()} keyExtractor={(line) => line.id} class="min-h-0 flex-1" contentClass="pb-4" testID="File preview">
          {(line) => (
            <View class="flex-col">
            <View testID={props.line === line().n ? "Revealed line" : undefined} class={`min-h-5 flex-row ${props.line === line().n || inDraft(line().n) ? "bg-muted-40" : ""}`}>
              {/* The gutter starts a comment on the line (a shift-press extends it from the last one pressed). */}
              <View role="button" accessibilityLabel={`Comment on line ${line().n}`} onPress={(event) => startComment(line().n, event.modifiers.shift)} style={{ width: gutter() }} class="shrink-0 pr-3 hover:bg-accent-50">
                <Text class="text-right font-mono text-xs text-muted-foreground">{String(line().n)}</Text>
              </View>
              <Text class={`min-w-0 flex-1 font-mono text-xs text-foreground ${wrap() ? "" : "truncate"}`}>{line().tokens.length === 0 ? (line().text || " ") : line().tokens.map((token) => <Text class={tokenClass(token.kind)}>{token.text}</Text>)}</Text>
            </View>
            {fileComments().filter((comment) => comment.endLine === line().n).map((comment) => (
              <View class="gap-1 border-y border-border bg-card px-3 py-2" accessibilityLabel="File comment">
                <Text class="text-xs text-muted-foreground">{formatFileCommentRange(comment.startLine, comment.endLine)}</Text>
                <Text class="text-xs text-foreground">{comment.text}</Text>
                <View class="flex-row justify-end"><View role="button" accessibilityLabel="Delete comment" onPress={() => deleteComment(comment.id)} class="size-5 items-center justify-center rounded-md hover:bg-accent"><HIcon name="trash-2" size={12} /></View></View>
              </View>
            ))}
            {draft() && draft()!.endLine === line().n ? (
              <View class="gap-2 border-y border-border bg-card p-2" accessibilityLabel="New comment">
                <Input
                  multiline
                  accessibilityLabel={`Comment on lines ${formatFileCommentRange(draft()!.startLine, draft()!.endLine)}`}
                  placeholder="Add a comment…"
                  value={draftText()}
                  onChange={(event) => draftText.set(event.value)}
                  onFocus={() => draftFocused.set(true)}
                  onBlur={() => draftFocused.set(false)}
                  onKeyPress={(event) => { if (event.key === "Escape") draft.set(null); }}
                  class="min-h-16 w-full rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
                />
                <View class="flex-row items-center justify-end gap-2">
                  <View role="button" accessibilityLabel="Cancel comment" onPress={() => draft.set(null)} class="h-6 items-center justify-center rounded-md px-2 hover:bg-accent"><Text class="text-xs text-foreground">Cancel</Text></View>
                  <View role="button" accessibilityLabel="Comment" disabled={draftText().trim() === ""} onPress={saveComment} class={`h-6 items-center justify-center rounded-md bg-primary px-2 ${draftText().trim() === "" ? "opacity-64" : ""}`}><Text class="text-xs text-primary-foreground">Comment</Text></View>
                </View>
              </View>
            ) : null}
            </View>
          )}
        </List>
      ) : null}
      {state() === "ready" && truncated() && !largeText() && !editable() && kind() !== "markdown" && kind() !== "mermaid" && kind() !== "html" ? <Text class="border-t border-border px-3 py-2 text-xs text-muted-foreground" testID="Large file notice">{`This file is too large to show in full. Showing the first ${formatByteLength(source().length)} of ${formatByteLength(byteLength())}.`}</Text> : null}
      </View>
      {showExplorer() ? (
        <FileExplorerPane resizable rowWidth={() => rowRect()?.width ?? 600}>
          <FilesPanel cwd={props.cwd} projectName={props.projectName ?? "Project"} selectedPath={() => props.relativePath} onOpenFile={(path) => props.onOpenFile?.(path)} request={rpc} />
        </FileExplorerPane>
      ) : null}
      </View>
    </View>
  );
}
