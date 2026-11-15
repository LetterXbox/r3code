// The PDF and Open XML viewer pages (third_party/doc-viewer: the reference's PdfViewer and OpenXmlOfficeViewer with
// pdfjs-dist and @betteroffice/*), each one HTML document kept gzipped and base64 across SVG assets (16 MiB each at most)'s metadata, read on first use.
import { VIEWER_PARTS } from "./viewers/parts";
import { VIEWER_ASSETS } from "./viewers/assets";

export type DocumentViewerKind = "pdf" | "docx" | "xlsx" | "pptx";
const overrides = new Map<DocumentViewerKind, readonly string[]>();

/** Tests give the page's parts themselves (a headless run cannot fetch the bundled assets). */
export function overrideDocumentViewer(kind: DocumentViewerKind, parts: readonly string[] | null) {
  if (parts === null) overrides.delete(kind); else overrides.set(kind, parts);
}

/** One part's base64 out of `<metadata>...</metadata>`. */
export function partFromAsset(asset: string): string {
  const match = asset.match(/<metadata>([A-Za-z0-9+/=]+)<\/metadata>/);
  if (!match) throw new Error("The document viewer asset is invalid");
  return match[1]!;
}

/** The page the web view opens: it gathers the parts the app posts ({type:"part"}), then on {type:"parts-done"}
 * writes the joined document (UTF-8) in its own place. The GPUI host takes a page only as an HTML string (no file:
 * pages, no base URL), and JS cannot hold a 50 MB page, so the parts go over the bridge one at a time. */
export const LOADER_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
var parts = [];
window.addEventListener("message", function (event) {
  var message; try { message = JSON.parse(String(event.data)); } catch (e) { return; }
  if (message.type === "part") parts.push(message.data);
  else if (message.type === "parts-done") {
    var b = atob(parts.join("")); parts = null; var u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    // The page is stored gzipped (third_party/doc-viewer/build.mjs).
    new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream("gzip"))).text().then(function (html) {
      document.open(); document.write(html); document.close();
    }, function (error) { window.nsh.postMessage(JSON.stringify({ type: "error", message: "Could not load the document viewer." })); });
  }
});
(function hello() { if (window.nsh) window.nsh.postMessage(JSON.stringify({ type: "loader-ready" })); else setTimeout(hello, 50); })();
</script></body></html>`;

/** Each part's base64, read one at a time from its asset, handed to `post` and dropped. */
export async function postViewerParts(kind: DocumentViewerKind, post: (base64: string) => void): Promise<void> {
  const override = overrides.get(kind);
  if (override) { for (const part of override) post(part); return; }
  for (const asset of VIEWER_PARTS[kind] as readonly { url: string }[]) {
    const response = await fetch(asset.url);
    if (!response.ok) throw new Error("Could not load the document viewer.");
    post(partFromAsset(await response.text()));
  }
}

/** The file as base64 pieces for the page (`{type:"chunk"}` messages), 1 MB of bytes each. */
export function base64Chunks(bytes: Uint8Array, size = 1024 * 1024): string[] {
  const out: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    const part = bytes.subarray(offset, offset + size);
    let binary = "";
    for (let index = 0; index < part.length; index += 0x8000) binary += String.fromCharCode(...part.subarray(index, index + 0x8000));
    out.push(btoa(binary));
  }
  return out;
}

/** The theme the page's Tailwind classes read (`--background`, ...), from the app's tokens. */
export const DOCUMENT_THEME_TOKENS = ["background", "foreground", "muted", "muted-foreground", "border", "input", "accent", "accent-foreground", "destructive", "destructive-foreground", "warning", "warning-foreground", "warning-surface", "popover", "popover-foreground", "ring", "primary", "primary-foreground", "card", "card-foreground", "secondary", "secondary-foreground", "success", "success-foreground", "info", "info-foreground"] as const;

/** A lazily fetched asset the page asked for (a font, a PDF CMap): its base64, read from its SVG part, or null. */
export async function viewerAsset(name: string): Promise<string | null> {
  const asset = VIEWER_ASSETS[name];
  if (!asset) return null;
  const response = await fetch(asset.url);
  if (!response.ok) return null;
  return partFromAsset(await response.text());
}
