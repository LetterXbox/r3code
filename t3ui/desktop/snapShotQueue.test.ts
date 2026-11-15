import { expect, test } from "nsh/test";
import { configureDesktop } from "./runtime";
import { acknowledgeSnapShot, emitSnapShotEvent, listPendingSnapShots, pendingCapturePngPath, readSnapShot, snapShotEvent, writePendingCapture } from "./snapShotQueue";

const contents = new Map<string, Uint8Array>();
const byteLength = (data: string | Uint8Array) => (typeof data === "string" ? new TextEncoder().encode(data).length : data.length);
const asBytes = (data: string | Uint8Array) => (typeof data === "string" ? new TextEncoder().encode(data) : data);

configureDesktop({
  dataDir: () => "/data",
  randomId: () => "id-1",
  mkdir: async () => undefined,
  writeFile: async (path, data) => { contents.set(path, asBytes(data)); },
  readFile: async (path) => { const data = contents.get(path); if (!data) throw new Error("ENOENT"); return data; },
  rename: async (from, to) => { const data = contents.get(from); if (!data) throw new Error("ENOENT"); contents.delete(from); contents.set(to, data); },
  unlink: async (path) => { contents.delete(path); },
  readdir: async (dir) => [...contents.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1)),
  fileSize: async (path) => { const data = contents.get(path); return data ? byteLength(data) : null; },
});

const reset = () => contents.clear();

test("a written capture is listed, read back as a data URL, and cleared on acknowledge", async () => {
  reset();
  contents.set("/data/snapshots/window-1.png", new Uint8Array([1, 2, 3]));
  await writePendingCapture("id-1", { pngPath: "/data/snapshots/window-1.png", name: "window-1.png", sizeBytes: 3, source: { kind: "snap-shot", capturedAt: "2026-01-01T00:00:00.000Z", appName: "Notes", windowTitle: "Todo" } });

  const pending = await listPendingSnapShots();
  expect(pending).toEqual([{ id: "id-1", name: "window-1.png", mimeType: "image/png", sizeBytes: 3, source: { kind: "snap-shot", capturedAt: "2026-01-01T00:00:00.000Z", appName: "Notes", windowTitle: "Todo" } }]);

  const entry = await readSnapShot("id-1");
  expect(entry.dataUrl).toBe(`data:image/png;base64,${btoa(String.fromCharCode(1, 2, 3))}`);
  expect(await pendingCapturePngPath("id-1")).toBe("/data/snapshots/window-1.png");

  await acknowledgeSnapShot("id-1");
  expect(await listPendingSnapShots()).toEqual([]);
  expect(contents.has("/data/snapshots/window-1.png")).toBe(false);
  expect(await pendingCapturePngPath("id-1")).toBe(null);
});

test("writePendingCapture writes the sidecar as a tmp file renamed into place (no half-written sidecar left behind)", async () => {
  reset();
  contents.set("/data/snapshots/w.png", new Uint8Array([9]));
  await writePendingCapture("id-1", { pngPath: "/data/snapshots/w.png", name: "w.png", sizeBytes: 1, source: { kind: "snap-shot", capturedAt: "t", appName: "A", windowTitle: "" } });
  expect(contents.has("/data/snapshots/id-1.json.tmp")).toBe(false);
  expect(contents.has("/data/snapshots/id-1.json")).toBe(true);
});

test("reading an unknown id throws, and readSnapShot never leaves a dangling queue entry it did not acknowledge", async () => {
  reset();
  await expect(readSnapShot("missing")).rejects.toThrow();
  expect(await pendingCapturePngPath("missing")).toBe(null);
});

test("acknowledging an id with no entry is a no-op (already cleared, or never persisted)", async () => {
  reset();
  await acknowledgeSnapShot("nothing-here");
});

test("events are a signal with a sequence number, so the same event shape twice still notifies", () => {
  emitSnapShotEvent({ type: "requested", id: "a" });
  const first = snapShotEvent();
  emitSnapShotEvent({ type: "requested", id: "a" });
  const second = snapShotEvent();
  expect(first?.event).toEqual({ type: "requested", id: "a" });
  expect(second?.event).toEqual({ type: "requested", id: "a" });
  expect(second?.seq).not.toBe(first?.seq);
});
