import { expect, test } from "nsh/test";
import { configureDesktop } from "../../desktop/runtime";
import {
  activeRecordingTabIds, artifactDirectory, forwardRecordingInput, isTabRecording, parseRecordingInputMessage,
  recordingCursorScript, recordingFrameRate, recordingInputOptions, recordingPrimaryColor, registerTabRecordingInjector,
  startTabRecording, stopTabRecording, captureTabScreenshot,
} from "./previewRecording";

test("fm13: a browser tab records through the host into the artifact folder, one recording at a time", async () => {
  const dirs: string[] = []; const files: string[] = [];
  configureDesktop({ dataDir: () => "/data/", mkdir: async (p) => { dirs.push(p); }, writeFile: async (p) => { files.push(p); } });
  expect(artifactDirectory()).toBe("/data/preview-artifacts");
  expect(recordingFrameRate(() => 60)).toBe(60);
  expect(recordingFrameRate(() => undefined)).toBe(30);
  const calls: { name: string; data: any }[] = [];
  const host = async (name: string, data: any) => { calls.push({ name, data }); return name === "webview.recordStop" ? { path: calls[0]!.data.path, mimeType: "video/mp4", sizeBytes: 42 } : { path: data?.path }; };
  await startTabRecording("browser:1", { x: 10, y: 20 }, host);
  expect(calls[0]!.name).toBe("webview.recordStart");
  expect(/^\/data\/preview-artifacts\/browser-recording-[a-z0-9]+\.mp4$/.test(calls[0]!.data.path)).toBe(true);
  expect(calls[0]!.data.point).toEqual({ x: 10, y: 20 });
  expect(isTabRecording("browser:1")).toBe(true);
  expect([...activeRecordingTabIds()]).toEqual(["browser:1"]);
  let conflict = "";
  await startTabRecording("browser:2", null, host).catch((e: Error) => { conflict = e.message; });
  expect(conflict).toBe("Another browser tab is already recording. Stop it before starting a new recording.");
  const artifact = await stopTabRecording("browser:1", host);
  expect(artifact).toEqual({ path: calls[0]!.data.path, mimeType: "video/mp4", sizeBytes: 42 });
  expect(isTabRecording("browser:1")).toBe(false);
  expect(await stopTabRecording("browser:1", host)).toBe(null);
  const shot = await captureTabScreenshot(null, async () => ({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" }));
  expect(/browser-screenshot-[a-z0-9]+\.png$/.test(shot.path)).toBe(true);
  expect(files).toEqual([shot.path]);
  let refused = "";
  await startTabRecording("browser:3", null, async () => { throw new Error("no handler for webview.recordStart"); }).catch((e: Error) => { refused = e.message; });
  expect(refused).toBe("no handler for webview.recordStart");
  expect(isTabRecording("browser:3")).toBe(false);
});

test("fm13: recordingInputOptions reads the two Settings > Browser > Recordings switches, both off by default", () => {
  expect(recordingInputOptions(() => undefined)).toEqual({ showKeyPresses: false, showMousePresses: false });
  expect(recordingInputOptions((k) => k === "browserRecordingShowKeyPresses")).toEqual({ showKeyPresses: true, showMousePresses: false });
});

test("fm13: recordingPrimaryColor converts the app's primary token to 0..1 floats, falling back when it cannot be parsed", () => {
  expect(recordingPrimaryColor(() => "#ff8000")).toEqual({ r: 1, g: 128 / 255, b: 0, a: 1 });
  expect(recordingPrimaryColor(() => "not-a-color").a).toBe(1);
});

test("fm13: parseRecordingInputMessage accepts clear/key/pointer and rejects anything else", () => {
  expect(parseRecordingInputMessage('{"t3":"recordingInput","input":{"type":"clear"}}')).toEqual({ type: "clear" });
  expect(parseRecordingInputMessage('{"t3":"recordingInput","input":{"type":"key","label":"⌘K","held":true,"width":800}}')).toEqual({ type: "key", label: "⌘K", held: true, width: 800 });
  expect(parseRecordingInputMessage('{"t3":"recordingInput","input":{"type":"pointer","phase":"down","x":1,"y":2,"width":800,"height":600}}')).toEqual({ type: "pointer", phase: "down", x: 1, y: 2, width: 800, height: 600 });
  expect(parseRecordingInputMessage('{"t3":"other"}')).toBe(null);
  expect(parseRecordingInputMessage("not json")).toBe(null);
  expect(parseRecordingInputMessage('{"t3":"recordingInput","input":{"type":"pointer","phase":"sideways","x":1,"y":2,"width":1,"height":1}}')).toBe(null);
});

test("fm13: forwardRecordingInput calls webview.recordInput while recording and stops after the host rejects once", async () => {
  configureDesktop({ dataDir: () => "/data/", mkdir: async () => {}, writeFile: async () => {} });
  let rejects = true;
  const calls: unknown[] = [];
  const host = async (name: string, data: unknown) => { if (name === "webview.recordInput") { calls.push(data); if (rejects) throw new Error("no handler for webview.recordInput"); return null; } return { path: "/data/x.mp4" }; };
  await startTabRecording("browser:4", null, host);
  await forwardRecordingInput("browser:4", { type: "clear" }, host);
  expect(calls.length).toBe(1);
  await forwardRecordingInput("browser:4", { type: "clear" }, host);
  expect(calls.length).toBe(1); // unsupported after the first rejection: no further call for this recording
  await stopTabRecording("browser:4", host);
  rejects = false;
  await startTabRecording("browser:4", null, host);
  await forwardRecordingInput("browser:4", { type: "clear" }, host);
  expect(calls.length).toBe(2); // a fresh recording tries again
  await stopTabRecording("browser:4", host);
});

test("fm13: registerTabRecordingInjector's script runs on start and dispose on stop", async () => {
  configureDesktop({ dataDir: () => "/data/", mkdir: async () => {}, writeFile: async () => {} });
  const scripts: string[] = [];
  const release = registerTabRecordingInjector("browser:5", (s) => scripts.push(s));
  const host = async (name: string) => (name === "webview.recordStop" ? { path: "/data/x.mp4" } : { path: "/data/x.mp4" });
  await startTabRecording("browser:5", null, host);
  expect(scripts.length).toBe(1);
  expect(scripts[0]).toContain("installPreviewRecording");
  await stopTabRecording("browser:5", host);
  expect(scripts[1]).toContain("__t3record");
  release();
});

test("fm13: recordingCursorScript embeds the options and primary colour as a call to the generated installer", () => {
  const script = recordingCursorScript({ showKeyPresses: true, showMousePresses: false }, "#2563eb");
  expect(script).toContain("installPreviewRecording");
  expect(script).toContain("\"showKeyPresses\":true");
  expect(script).toContain("#2563eb");
});
