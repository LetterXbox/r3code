// Single-file viewers: audio and font samples (below), and a video in the platform's player (FilePreviewPanel.tsx WorkspaceVideoPreview over MediaVideoPlayer) and a
// Mermaid file drawn as its diagram (files/MermaidViewer.tsx), with the web app's refusal of sources that carry markup or URLs.
import { colorScheme, computed, effect, Image, Scroll, signal, Text, token, Video, View } from "nsh";
import { mixColors } from "../sidebar/mix";
import { pelePalette, renderMermaid } from "../thread/markdown/mermaid";
import { FileSurfaceFailure } from "./fileSurfaceChrome";
import { workspaceFileUrl } from "./filesLogic";
import { readWorkspaceBytes } from "./workspaceBytes";

/** Larger videos are not copied into memory when the player cannot open the file itself. */
export const VIDEO_FALLBACK_MAX_BYTES = 256 * 1024 * 1024;

const VIDEO_TYPES: Record<string, string> = { avi: "video/x-msvideo", m4v: "video/mp4", mkv: "video/x-matroska", mov: "video/quicktime", mp4: "video/mp4", ogv: "video/ogg", webm: "video/webm" };

export function VideoFileView(props: { cwd: string; relativePath: string; readBytes?: (cwd: string, relativePath: string, maxBytes: number) => Promise<Uint8Array> }) {
  const read = props.readBytes ?? readWorkspaceBytes;
  // The player opens the file's own URL first; a player that cannot (a scheme or a codec) is given the bytes as an object URL.
  const stage = signal<"file" | "bytes" | "failed">("file");
  const bytesUrl = signal("");
  let released = "";
  const retry = signal(0);
  effect(() => {
    void props.cwd;
    void props.relativePath;
    void retry();
    stage.set("file");
    return () => { if (released) { URL.revokeObjectURL(released); released = ""; } };
  });
  async function fallBack() {
    if (stage() !== "file") { stage.set("failed"); return; }
    try {
      const bytes = await read(props.cwd, props.relativePath, VIDEO_FALLBACK_MAX_BYTES);
      const extension = props.relativePath.slice(props.relativePath.lastIndexOf(".") + 1).toLowerCase();
      released = URL.createObjectURL(new Blob([bytes], { type: VIDEO_TYPES[extension] ?? "video/mp4" }));
      bytesUrl.set(released);
      stage.set("bytes");
    } catch {
      stage.set("failed");
    }
  }
  const src = () => (stage() === "bytes" ? bytesUrl() : workspaceFileUrl(props.cwd, props.relativePath));
  return (
    <View class="min-h-0 flex-1 items-center justify-center overflow-hidden p-4" accessibilityLabel="Video preview">
      {stage() === "failed" ? (
        <View class="items-center gap-3 px-6">
          <Text class="text-center text-xs text-muted-foreground">Video preview unavailable</Text>
          <View role="button" accessibilityLabel="Retry video" onPress={() => retry.update((value) => value + 1)} class="rounded-md border border-input px-2.5 py-1 hover:bg-accent"><Text class="text-xs text-foreground">Try again</Text></View>
        </View>
      ) : (
        <Video src={src()} controls paused class="h-full w-full max-w-5xl" accessibilityLabel={props.relativePath} onError={() => void fallBack()} />
      )}
    </View>
  );
}

/** The sources the web viewer refuses before drawing: markup, resource URLs, node metadata and custom configuration. */
export function mermaidSourceRefused(text: string): boolean {
  return /%%\s*\{|^\s*---|<\/?[A-Za-z]|<[!?]|@\s*\{|\b(?:img|image)\s*:|url\s*\(|@import|(?:https?|data|blob|file):/im.test(text);
}

export function MermaidFileView(props: { text: string }) {
  const palette = computed(() => { colorScheme(); return pelePalette((name) => String(token(name as never)), mixColors); });
  const refused = computed(() => mermaidSourceRefused(props.text));
  const result = computed(() => (refused() || props.text.trim() === "" ? null : renderMermaid(props.text, palette())));
  const diagram = () => { const current = result(); return current !== null && current.ok ? current : null; };
  const failure = () => { const current = result(); return current !== null && !current.ok ? current.message : ""; };
  return (
    <View class="min-h-0 flex-1" accessibilityLabel="Mermaid preview">
      {refused() ? <Text class="p-6 text-xs text-muted-foreground" role="alert">This diagram contains resource URLs, markup, node metadata, or custom configuration. Show Mermaid source to inspect it safely.</Text> : null}
      {failure() ? <FileSurfaceFailure message={failure()} /> : null}
      {diagram() ? (
        <Scroll class="min-h-0 flex-1" contentClass="items-start p-6" testID="Mermaid diagram">
          <Image src={diagram()!.url} accessibilityLabel="Mermaid diagram" style={{ width: diagram()!.width, height: diagram()!.height, maxWidth: "100%", objectFit: "contain" }} />
        </Scroll>
      ) : null}
    </View>
  );
}

/** An audio file in the platform's player (the GPUI host gives a web page no file URLs or base URL, so the native
 * player plays it); one it cannot play says what the reference's audio chip says, with a retry. */
export function AudioFileView(props: { cwd: string; relativePath: string; readBytes?: (cwd: string, relativePath: string, maxBytes: number) => Promise<Uint8Array> }) {
  const read = props.readBytes ?? readWorkspaceBytes;
  const stage = signal<"file" | "bytes" | "failed">("file");
  const bytesUrl = signal("");
  const retry = signal(0);
  let released = "";
  effect(() => { void retry(); stage.set("file"); return () => { if (released) { URL.revokeObjectURL(released); released = ""; } }; });
  async function fallBack() {
    if (stage() !== "file") { stage.set("failed"); return; }
    try {
      const bytes = await read(props.cwd, props.relativePath, VIDEO_FALLBACK_MAX_BYTES);
      released = URL.createObjectURL(new Blob([bytes as BlobPart]));
      bytesUrl.set(released);
      stage.set("bytes");
    } catch {
      stage.set("failed");
    }
  }
  const name = props.relativePath.slice(props.relativePath.lastIndexOf("/") + 1);
  return (
    <View class="min-h-0 flex-1 items-center justify-center p-4" accessibilityLabel="Audio preview">
      {stage() === "failed" ? (
        <View class="items-center gap-3 px-6">
          <Text class="text-center text-xs text-muted-foreground">Audio unavailable. Open the file or retry playback.</Text>
          <View role="button" accessibilityLabel={`Audio unavailable. Play ${name}`} onPress={() => retry.update((value) => value + 1)} class="rounded-md border border-input px-2.5 py-1 hover:bg-accent"><Text class="text-xs text-foreground">Try again</Text></View>
        </View>
      ) : (
        <Video src={stage() === "bytes" ? bytesUrl() : workspaceFileUrl(props.cwd, props.relativePath)} controls paused class="h-14 w-full max-w-xl" accessibilityLabel={name} onError={() => void fallBack()} />
      )}
    </View>
  );
}

/** FontViewer's MAX_FONT_BYTES. */
export const MAX_FONT_BYTES = 10 * 1024 * 1024;

/** The font's sample page, with the font itself inlined (the host takes a page only as a string, no base URL). */
export function fontSampleHtml(base64: string, mime: string): string {
  return `<!doctype html><meta charset="utf-8"><style>@font-face{font-family:"preview";src:url("data:${mime};base64,${base64}")}body{margin:0;padding:16px;font-family:"preview",sans-serif;color:#888;background:transparent;color-scheme:light dark}p{margin:0 0 12px}</style><body><p style="font-size:48px">Aa Bb Cc 0123</p><p style="font-size:28px">The quick brown fox jumps over the lazy dog</p><p style="font-size:18px">ABCDEFGHIJKLMNOPQRSTUVWXYZ</p><p style="font-size:18px">abcdefghijklmnopqrstuvwxyz</p><p style="font-size:14px">0123456789 !@#$%^&amp;*()[]{}</p></body>`;
}
