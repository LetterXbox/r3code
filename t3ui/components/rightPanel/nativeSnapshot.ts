// A still image of a WebView to show in its place while an overlay occludes it (see nativeOcclusion.ts).
// When `occluded` turns true the host asks its page for a snapshot (`request`); the page answers with a data URL
// (`receive`) or an error (`fail`). The image is accepted only while the same occlusion is still open and within
// `timeoutMs`; until then, and as the fallback, the host shows its neutral placeholder. When the occlusion ends the
// image is dropped and the WebView shows again.
//
// Only canvas-backed documents (the Ghostty terminal) can answer fast enough: measured 7-16 ms in page, 18-125 ms
// round trip. A general web page cannot be rasterised from inside in time (SVG foreignObject took ~40 s on
// github.com), and an OS screen capture needs the Screen Recording permission, so the browser keeps the placeholder.
import { effect, signal, untracked } from "nsh";

export const SNAPSHOT_TIMEOUT_MS = 300;

/** The script a canvas-backed page runs to post `{ type: "snapshot", token, url }` (or `snapshot-error`) back. */
export function canvasSnapshotScript(token: number): string {
  return `(() => { try { const c = document.querySelector("canvas"); if (!c) throw new Error("no canvas");
window.nsh.postMessage(JSON.stringify({ type: "snapshot", token: ${token}, url: c.toDataURL("image/png") }));
} catch (e) { window.nsh.postMessage(JSON.stringify({ type: "snapshot-error", token: ${token}, message: String(e) })); } })();`;
}

export interface SnapshotHost {
  /** The image to show instead of the WebView, or null (show the placeholder while occluded). */
  image(): string | null;
  /** A snapshot arrived for request `token`. */
  receive(token: number, url: string): void;
  /** The page could not take snapshot `token`. */
  fail(token: number): void;
  /** Handles a page message if it is a snapshot reply; returns whether it was one. */
  handleMessage(message: { type?: unknown; token?: unknown; url?: unknown }): boolean;
}

/** Tracks `occluded` (call inside a component or effect scope) and asks `request(token)` for a snapshot on each new occlusion. */
export function createSnapshotHost(occluded: () => boolean, request: (token: number) => void, timeoutMs = SNAPSHOT_TIMEOUT_MS): SnapshotHost {
  const image = signal<string | null>(null);
  let token = 0;
  let waiting = false;

  effect(() => {
    if (!occluded()) return;
    const current = ++token;
    waiting = true;
    untracked(() => image.set(null));
    const timer = setTimeout(() => { if (token === current) waiting = false; }, timeoutMs);
    try { request(current); } catch { waiting = false; }
    return () => {
      clearTimeout(timer);
      waiting = false;
      token++;
      untracked(() => image.set(null));
    };
  });

  const host: SnapshotHost = {
    image: () => image(),
    receive(reply, url) {
      if (!waiting || reply !== token || !url.startsWith("data:image/")) return;
      waiting = false;
      image.set(url);
    },
    fail(reply) {
      if (reply === token) waiting = false;
    },
    handleMessage(message) {
      if (message.type === "snapshot" && typeof message.token === "number" && typeof message.url === "string") {
        host.receive(message.token, message.url);
        return true;
      }
      if (message.type === "snapshot-error" && typeof message.token === "number") {
        host.fail(message.token);
        return true;
      }
      return false;
    },
  };
  return host;
}
