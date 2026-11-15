// remoteOpen.ts (apps/web/src) and buildRemoteOpenUrl (contracts editor.ts): a thread on another machine cannot have its
// editor launched there by this client; its folder opens through the editor's remote URL scheme instead (VS Code family
// vscode-remote over ssh, Zed ssh, JetBrains Gateway). The machine's address comes from its server config's
// remoteOpenTargets (Tailscale / mDNS); the port connects to saved environments by URL, not through an SSH profile, so
// the ssh-alias source the reference also uses does not occur here.
import { Storage } from "nsh";

export interface RemoteOpenHost { kind: string; host: string; username?: string }
export type RemoteOpenState = { mode: "local-exec" } | { mode: "remote-links"; host: RemoteOpenHost } | { mode: "remote-unavailable" };

const REMOTE_SCHEMES: Record<string, string> = { cursor: "cursor", vscode: "vscode", "vscode-insiders": "vscode-insiders", vscodium: "vscodium", zed: "zed" };
const JETBRAINS_CODES: Record<string, string> = { idea: "IU", aqua: "QA", clion: "CL", datagrip: "DB", dataspell: "DS", goland: "GO", phpstorm: "PS", pycharm: "PY", rider: "RD", rubymine: "RM", rustrover: "RR", webstorm: "WS" };
/** REMOTE_CAPABLE_EDITOR_IDS. */
export const REMOTE_CAPABLE_EDITOR_IDS: readonly string[] = [...Object.keys(REMOTE_SCHEMES), ...Object.keys(JETBRAINS_CODES)];

/** resolveRemoteOpenState for a thread: no environment (the primary, this machine) launches locally; a saved environment
 * opens through its advertised remote-open target, else it has no route. */
export function resolveRemoteOpenState(environmentId: string | null | undefined, config: Record<string, unknown> | null | undefined): RemoteOpenState {
  if (!environmentId) return { mode: "local-exec" };
  const targets = Array.isArray(config?.remoteOpenTargets) ? config!.remoteOpenTargets as unknown[] : [];
  const first = targets[0] as { kind?: unknown; host?: unknown; username?: unknown } | undefined;
  if (first && typeof first.host === "string" && first.host.length > 0) {
    return { mode: "remote-links", host: { kind: typeof first.kind === "string" ? first.kind : "tailscale", host: first.host, ...(typeof first.username === "string" ? { username: first.username } : {}) } };
  }
  return { mode: "remote-unavailable" };
}

/** buildRemoteOpenUrl (contracts editor.ts), 1:1. */
export function buildRemoteOpenUrl(input: { editor: string; host: string; username?: string | undefined; absolutePath: string; isFile?: boolean }): string | undefined {
  const product = JETBRAINS_CODES[input.editor];
  if (product) {
    const params = new URLSearchParams({ h: input.host, launchIde: "true", ideHint: product, projectHint: input.absolutePath.replaceAll("\\", "/") });
    if (input.username !== undefined) params.set("u", input.username);
    return `jetbrains://gateway/ssh/environment?${params.toString()}`;
  }
  const scheme = REMOTE_SCHEMES[input.editor];
  if (scheme === undefined) return undefined;
  const posixPath = input.absolutePath.replaceAll("\\", "/");
  const rootedPath = posixPath.startsWith("/") ? posixPath : `/${posixPath}`;
  const encodedHost = encodeURIComponent(input.host);
  if (input.editor === "zed") {
    const zedPath = /^[Cc]:[\\/]/.test(input.absolutePath) ? rootedPath.slice(3) : rootedPath;
    const encodedZedPath = zedPath.split("/").map(encodeURIComponent).join("/");
    const destination = input.username === undefined ? encodedHost : `${encodeURIComponent(input.username)}@${encodedHost}`;
    return `${scheme}://ssh/${destination}${encodedZedPath}`;
  }
  const encodedPath = rootedPath.split("/").map(encodeURIComponent).join("/");
  const destination = input.username === undefined ? input.host : `${input.username}@${input.host}`;
  return `${scheme}://vscode-remote/ssh-remote+${encodeURIComponent(destination)}${encodedPath}${input.isFile ? ":1:1" : ""}`;
}

/** The remote editor: the last one used when it can open remote links, else VS Code (REMOTE_FALLBACK_EDITORS). The
 * reference probes the desktop for installed remote-capable editors; the port has no probe, so it uses the fallback. */
export async function preferredRemoteEditor(): Promise<string> {
  const last = await Storage.getItem("lastEditor").catch(() => null);
  return last && REMOTE_CAPABLE_EDITOR_IDS.includes(last) ? last : "vscode";
}

/** OpenInPicker / OpenInPickerShortcut: opens `cwd` in `editor`, on this machine for a local thread, through the editor's
 * remote link for a thread of another machine (the picked editor when it can open remote links, else VS Code). A
 * machine without a route says so (the picker's "No SSH route to <machine>"). */
export async function openFolderInEditor(input: { cwd: string; editor: string; environmentId: string | null | undefined; environmentLabel?: string | undefined; config: Record<string, unknown> | null | undefined; launchLocal: () => Promise<unknown>; openUrl: (url: string) => Promise<unknown> }): Promise<void> {
  const state = resolveRemoteOpenState(input.environmentId, input.config);
  if (state.mode === "local-exec") { await input.launchLocal(); return; }
  if (state.mode === "remote-unavailable") throw new Error(`No SSH route to ${input.environmentLabel ?? "this machine"}`);
  const editor = REMOTE_CAPABLE_EDITOR_IDS.includes(input.editor) ? input.editor : "vscode";
  const url = buildRemoteOpenUrl({ editor, host: state.host.host, ...(state.host.username !== undefined ? { username: state.host.username } : {}), absolutePath: input.cwd });
  if (!url) throw new Error("This editor cannot open a remote folder.");
  await input.openUrl(url);
}
