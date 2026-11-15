// The async pending-capture queue (DesktopSnapShot.ts prepareCapture/persistCapture/listPending/read/acknowledge,
// apps/desktop/src/ipc/methods/snapShot.ts:163-239, and the requested/started/ready/failed events
// SnapShotCoordinator.tsx drains). The reference writes a capture's PNG and a JSON sidecar under its state dir and
// only ever addresses them by `id`; the port keeps the PNG at the path desktop/snapShot.ts already captures it to
// (so capture's own tests, and its filenames, are untouched) and writes just the sidecar under `snapshotsDir()`,
// named by `id`, pointing back at that PNG path. `listPendingSnapShots` / `readSnapShot` / `acknowledgeSnapShot`
// read, assemble and clear those sidecars; `acknowledgeSnapShot` also removes the PNG. A sidecar nothing
// acknowledged (the app quit between "ready" and the composer's own attach) survives for the next launch to find.
import { signal } from "nsh";
import { desktop, snapshotsDir } from "./runtime";

/** contracts chatAttachment.ts SnapShotSource, as the wire shape captureSnapShotToDraft already builds it
 * (snapShotSource.ts snapShotWireSource). Kept loose here: the queue only stores and returns it. */
export type SnapShotQueueSource = Record<string, unknown> & { kind: "snap-shot"; capturedAt: string };

export interface PendingSnapShot {
  id: string;
  name: string;
  mimeType: "image/png";
  sizeBytes: number;
  source: SnapShotQueueSource;
}

export interface SnapShotEntry extends PendingSnapShot {
  dataUrl: string;
}

/** `id` is absent for a failure before a capture exists (ipc.ts DesktopSnapShotEvent). */
export type SnapShotLifecycleEvent =
  | { type: "requested"; id: string }
  | { type: "started"; id: string }
  | { type: "ready"; id: string }
  | { type: "failed"; id?: string }
  | { type: "shortcut-changed" };

/** The latest lifecycle event, with a sequence number so the same event shape twice in a row still notifies
 * (SnapShotCoordinator.tsx's `onSnapShotEvent`, here as a signal instead of an IPC subscription). */
export const snapShotEvent = signal<{ event: SnapShotLifecycleEvent; seq: number } | null>(null);
let seq = 0;

export function emitSnapShotEvent(event: SnapShotLifecycleEvent): void {
  seq += 1;
  snapShotEvent.set({ event, seq });
}

interface SidecarJson { id: string; name: string; mimeType: "image/png"; sizeBytes: number; pngPath: string; source: SnapShotQueueSource }

function sidecarPath(id: string): string | null {
  const dir = snapshotsDir();
  return dir ? `${dir}/${id}.json` : null;
}

function isSidecarName(name: string): boolean {
  return name.endsWith(".json") && !name.endsWith(".json.tmp");
}

async function readSidecar(path: string): Promise<SidecarJson | undefined> {
  try {
    const text = await desktop().readFile(path).then((bytes) => new TextDecoder().decode(bytes));
    const parsed = JSON.parse(text) as Partial<SidecarJson>;
    if (typeof parsed.id !== "string" || typeof parsed.name !== "string" || typeof parsed.pngPath !== "string") return undefined;
    if (typeof parsed.sizeBytes !== "number" || !parsed.source || typeof parsed.source !== "object") return undefined;
    return { id: parsed.id, name: parsed.name, mimeType: "image/png", sizeBytes: parsed.sizeBytes, pngPath: parsed.pngPath, source: parsed.source as SnapShotQueueSource };
  } catch {
    return undefined;
  }
}

/** Writes the capture's queue entry (DesktopSnapShot.ts persistCapture): a `.json.tmp` written then renamed to
 * `.json`, so a reader never sees a half-written sidecar. The PNG itself is left where it already is. */
export async function writePendingCapture(id: string, capture: { pngPath: string; name: string; sizeBytes: number; source: SnapShotQueueSource }): Promise<void> {
  const dir = snapshotsDir();
  if (!dir) throw new Error("This app has no data folder to save the snapshot in.");
  await desktop().mkdir(dir);
  const final = sidecarPath(id)!;
  const tmp = `${final}.tmp`;
  const sidecar: SidecarJson = { id, name: capture.name, mimeType: "image/png", sizeBytes: capture.sizeBytes, pngPath: capture.pngPath, source: capture.source };
  await desktop().writeFile(tmp, JSON.stringify(sidecar));
  await desktop().rename(tmp, final);
}

function toPending(sidecar: SidecarJson): PendingSnapShot {
  return { id: sidecar.id, name: sidecar.name, mimeType: "image/png", sizeBytes: sidecar.sizeBytes, source: sidecar.source };
}

/** DesktopSnapShot.ts `listPending`: every queued capture, oldest first. */
export async function listPendingSnapShots(): Promise<PendingSnapShot[]> {
  const dir = snapshotsDir();
  if (!dir) return [];
  const names = await desktop().readdir(dir);
  const sidecars = await Promise.all(names.filter(isSidecarName).map((name) => readSidecar(`${dir}/${name}`)));
  return sidecars
    .filter((sidecar): sidecar is SidecarJson => sidecar !== undefined)
    .map(toPending)
    .sort((left, right) => left.source.capturedAt.localeCompare(right.source.capturedAt));
}

function chunkedBase64(bytes: Uint8Array): string {
  // A single `String.fromCharCode(...bytes)` spread can overflow the call stack for a full-window PNG.
  const CHUNK = 0x2000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

/** Where a queued capture's PNG actually lives (same-process recovery only: `drainPendingSnapShots` reattaches a
 * capture directly from disk instead of round-tripping it through `readSnapShot`'s data URL). `null` for an id with
 * no entry. */
export async function pendingCapturePngPath(id: string): Promise<string | null> {
  const path = sidecarPath(id);
  const sidecar = path ? await readSidecar(path) : undefined;
  return sidecar?.pngPath ?? null;
}

/** DesktopSnapShot.ts `read`: the entry's metadata plus its PNG as a data URL. */
export async function readSnapShot(id: string): Promise<SnapShotEntry> {
  const path = sidecarPath(id);
  const sidecar = path ? await readSidecar(path) : undefined;
  if (!sidecar) throw new Error("This snapshot is no longer pending.");
  const bytes = await desktop().readFile(sidecar.pngPath);
  return { ...toPending(sidecar), dataUrl: `data:image/png;base64,${chunkedBase64(bytes)}` };
}

/** DesktopSnapShot.ts `acknowledge`: removes the sidecar and its PNG. Missing files are not an error (already
 * cleared, or the PNG never existed because a capture failed before persisting). */
export async function acknowledgeSnapShot(id: string): Promise<void> {
  const path = sidecarPath(id);
  if (!path) return;
  const sidecar = await readSidecar(path);
  if (sidecar) await desktop().unlink(sidecar.pngPath).catch(() => undefined);
  await desktop().unlink(path).catch(() => undefined);
  await desktop().unlink(`${path}.tmp`).catch(() => undefined);
}
