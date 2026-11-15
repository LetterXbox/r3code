// PdfViewer / OpenXmlOfficeViewer in a web view: the page (documentViewerPages.ts) says it is ready, the app sends the theme,
// then the file's bytes, then opens it. Find in PDF, pages, zoom, slides with notes and Word pages are the page's own.
import { colorScheme, effect, signal, Text, token, View, WebView } from "nsh";
import type { WebViewRef } from "nsh";
import { measureInto, panelViewOccluded, type PageRect } from "../rightPanel/nativeOcclusion";
import { base64Chunks, DOCUMENT_THEME_TOKENS, LOADER_PAGE, postViewerParts, viewerAsset, type DocumentViewerKind } from "./documentViewerPages";
import { readWorkspaceBytes } from "./workspaceBytes";
import { FileSurfaceFailure } from "./fileSurfaceChrome";

/** OFFICE_PREVIEW_MAX_BYTES and PdfViewer's bound: 50 MB. */
const MAX_BYTES = 50 * 1024 * 1024;

export function DocumentViewer(props: { kind: DocumentViewerKind; cwd: string; relativePath: string; readBytes?: (cwd: string, relativePath: string, maxBytes: number) => Promise<Uint8Array> }) {
  const failure = signal("");
  const ownRect = signal<PageRect | null>(null);
  let host: { measure(): Promise<any> } | undefined;
  let view: WebViewRef | null = null;
  const name = props.relativePath.slice(props.relativePath.lastIndexOf("/") + 1);
  const theme = () => JSON.stringify({ type: "theme", dark: colorScheme() === "dark", vars: Object.fromEntries(DOCUMENT_THEME_TOKENS.map((name) => [name, token(name)])) });
  let ready = false;
  effect(() => { const message = theme(); if (ready) view?.postMessage(message); });
  // The bytes are read while the page loads; a file that cannot be read says so without waiting for the page.
  const read = () => (props.readBytes ?? readWorkspaceBytes)(props.cwd, props.relativePath, MAX_BYTES);
  let bytes = read();
  bytes.catch((cause) => failure.set(cause instanceof Error ? cause.message : String(cause)));
  async function send() {
    try {
      const loaded = await bytes;
      for (const data of base64Chunks(loaded)) view?.postMessage(JSON.stringify({ type: "chunk", data }));
      view?.postMessage(JSON.stringify({ type: "open", name, kind: props.kind }));
    } catch (cause) {
      failure.set(cause instanceof Error ? cause.message : String(cause));
    }
  }
  const onMessage = (data: string) => {
    let message: { type?: string; message?: string };
    try { message = JSON.parse(data); } catch { return; }
    if (message.type === "asset") {
      // A font or PDF data file the page fetches as it needs it (the page's assetBridge).
      const ask = message as { id?: string; name?: string };
      void viewerAsset(String(ask.name)).then(
        (data) => view?.postMessage(JSON.stringify(data === null ? { type: "asset", id: ask.id, error: `Missing viewer asset ${ask.name}` } : { type: "asset", id: ask.id, data })),
        (cause) => view?.postMessage(JSON.stringify({ type: "asset", id: ask.id, error: String(cause) })),
      );
    } else if (message.type === "loader-ready") {
      void postViewerParts(props.kind, (data) => view?.postMessage(JSON.stringify({ type: "part", data })))
        .then(() => view?.postMessage(JSON.stringify({ type: "parts-done" })))
        .catch((cause) => failure.set(cause instanceof Error ? cause.message : String(cause)));
    } else if (message.type === "ready") { ready = true; view?.postMessage(theme()); void send(); }
    else if (message.type === "error" && message.message) failure.set(message.message);
  };
  const occluded = () => panelViewOccluded(ownRect());
  const label = props.kind === "pdf" ? "PDF preview" : props.kind === "docx" ? "Word document preview" : props.kind === "xlsx" ? "Spreadsheet preview" : "Presentation preview";
  return (
    <View ref={(node: any) => { host = node; }} onLayout={() => measureInto(host, ownRect)} class="min-h-0 flex-1 bg-background" accessibilityLabel={label}>
      {failure() && props.kind !== "pdf" ? (
        // OpenXmlOfficeViewer's failure.
        <View role="alert" class="min-h-0 flex-1 items-center justify-center gap-1 px-6">
          <Text class="text-center text-sm font-medium text-foreground">No preview for this file</Text>
          <Text class="max-w-sm text-center text-xs text-muted-foreground">{`${failure()} Save it or open it in another app.`}</Text>
        </View>
      ) : failure() ? <FileSurfaceFailure message={failure()} onRetry={() => { failure.set(""); bytes = read(); bytes.catch((cause) => failure.set(cause instanceof Error ? cause.message : String(cause))); if (ready) void send(); }} />
        : <>
          {occluded() ? <View class="min-h-0 flex-1 bg-background" testID="File view occluded" /> : null}
          <WebView ref={(node: WebViewRef) => { view = node; }} html={LOADER_PAGE} class={occluded() ? "hidden" : "min-h-0 flex-1"} onMessage={(event) => onMessage(event.data)} onError={(event) => failure.set(event.message || "The file could not be loaded. Close it and try again.")} />
        </>}
    </View>
  );
}
