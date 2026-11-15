// Microphone capture and playback for the Voice settings (the web's browserPcmCapture.ts + an <audio> element). NSH has no
// raw audio API, so on macOS osascript (JXA over AVFoundation) records the default input to a 16 kHz mono float32 WAV
// (the PCM the environment's /api/voice/transcribe takes), meters it every 50 ms into a level file, and stops when a
// stop file appears; playback is an AVAudioPlayer driven through a control file and reporting into a position file.
// Audio stays in the app's data directory: nothing is sent anywhere unless the caller sends it.
// When the launcher built the microphone helper (tools/mic-helper/t3-mic.swift, path in T3GPUI_MIC_HELPER), recording
// and the input device list go through it instead: AVAudioEngine on the chosen CoreAudio device (by UID), resampled to the
// same 16 kHz mono float32 WAV and the same level/stop files. osascript starts it (NSTask), so it stays a child of the app
// and the microphone prompt names the app.
import { readFile } from "fs/promises";
import { desktop, isMac } from "./runtime";
import { OSASCRIPT } from "./dialogs";

const RECORD_SCRIPT = `function run(argv) {
  ObjC.import("AVFoundation"); ObjC.import("Foundation");
  var wav = argv[0], levels = argv[1], stop = argv[2], max = Number(argv[3]);
  var fm = $.NSFileManager.defaultManager;
  var settings = $.NSDictionary.dictionaryWithDictionary({ AVFormatIDKey: 1819304813, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsBigEndianKey: false });
  var recorder = $.AVAudioRecorder.alloc.initWithURLSettingsError($.NSURL.fileURLWithPath(wav), settings, null);
  if (!recorder || recorder.isNil()) return JSON.stringify({ error: "audio-capture" });
  recorder.meteringEnabled = true;
  if (!recorder.record) return JSON.stringify({ error: "not-allowed" });
  var started = Date.now();
  while (true) {
    delay(0.05);
    recorder.updateMeters;
    var db = recorder.averagePowerForChannel(0);
    var level = Math.min(1, Math.pow(10, db / 20) * 4);
    $(JSON.stringify({ level: level, seconds: (Date.now() - started) / 1000 })).writeToFileAtomicallyEncodingError(levels, true, 4, null);
    if (fm.fileExistsAtPath(stop) || (Date.now() - started) / 1000 >= max) break;
  }
  var seconds = recorder.currentTime;
  recorder.stop;
  return JSON.stringify({ seconds: seconds });
}`;

const PLAY_SCRIPT = `function run(argv) {
  ObjC.import("AVFoundation"); ObjC.import("Foundation");
  var wav = argv[0], control = argv[1], position = argv[2];
  var player = $.AVAudioPlayer.alloc.initWithContentsOfURLError($.NSURL.fileURLWithPath(wav), null);
  if (!player || player.isNil()) return JSON.stringify({ error: "playback" });
  player.prepareToPlay; player.play;
  var last = "play";
  while (true) {
    delay(0.05);
    var raw = $.NSString.stringWithContentsOfFileEncodingError(control, 4, null);
    var command = raw && !raw.isNil() ? raw.js.trim() : last;
    if (command !== last) {
      last = command;
      if (command === "pause") player.pause;
      else if (command === "play") player.play;
      else if (command === "stop") break;
      else if (command.indexOf("seek:") === 0) { player.currentTime = Number(command.slice(5)); player.play; last = "play"; }
    }
    $(JSON.stringify({ current: player.currentTime, duration: player.duration, playing: !!player.playing })).writeToFileAtomicallyEncodingError(position, true, 4, null);
    if (!player.playing && last === "play") break;
  }
  player.stop;
  return JSON.stringify({ done: true });
}`;

/** Runs argv[0] with the rest as its arguments and returns its standard output (the helper's one JSON line). */
const HELPER_SCRIPT = `function run(argv) {
  ObjC.import("Foundation");
  var task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(argv[0]);
  task.arguments = $(argv.slice(1));
  var pipe = $.NSPipe.pipe;
  task.standardOutput = pipe;
  if (!task.launchAndReturnError(null)) return JSON.stringify({ error: "audio-capture" });
  var data = pipe.fileHandleForReading.readDataToEndOfFile;
  task.waitUntilExit;
  return $.NSString.alloc.initWithDataEncoding(data, 4).js.trim();
}`;

/** An input device: `deviceId` is its CoreAudio UID (what `voiceMicrophone` stores), `label` its name. */
export interface Microphone { deviceId: string; label: string }

/** Tests replace capture so no test ever opens the real microphone. */
export interface AudioCaptureImpl { available: () => boolean; startCapture: typeof realStartCapture; startPlayback: typeof realStartPlayback; listMicrophones?: () => Promise<Microphone[]> }
let override: AudioCaptureImpl | null = null;
export function setAudioCaptureForTest(next: AudioCaptureImpl | null) { override = next; }

const micHelper = (): string | null => (isMac() ? process.env.T3GPUI_MIC_HELPER || null : null);

/** The input devices (listBrowserMicrophones): empty without the helper, as the reference's list without enumerateDevices. */
export async function listMicrophones(): Promise<Microphone[]> {
  if (override) return override.listMicrophones ? override.listMicrophones() : [];
  const helper = micHelper();
  if (!helper) return [];
  try {
    const output = await desktop().run(OSASCRIPT, ["-l", "JavaScript", "-e", HELPER_SCRIPT, helper, "list"], { timeoutMs: 15_000 });
    const parsed = JSON.parse(output.stdout.trim()) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry, index) => {
      const value = entry as { uid?: unknown; name?: unknown };
      return typeof value.uid === "string" && value.uid ? [{ deviceId: value.uid, label: typeof value.name === "string" && value.name ? value.name : `Microphone ${index + 1}` }] : [];
    });
  } catch {
    return [];
  }
}

export const canCaptureAudio = () => (override ? override.available() : isMac() && desktop().dataDir() !== null);
export const startCapture: typeof realStartCapture = (options) => (override ? override.startCapture(options) : realStartCapture(options));
export const startPlayback: typeof realStartPlayback = (path, onPosition) => (override ? override.startPlayback(path, onPosition) : realStartPlayback(path, onPosition));

function voiceDir(): string {
  const dir = desktop().dataDir();
  if (!dir) throw new Error("Microphone testing is unavailable in this browser. Use HTTPS or the desktop app.");
  return `${dir}/voice`;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; } catch { return null; }
}

/** The samples of a float32 WAV's data chunk (AVAudioRecorder may write FLLR padding chunks before it). */
export function wavFloat32Data(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
    const size = view.getUint32(offset + 4, true);
    if (id === "data") return bytes.subarray(offset + 8, Math.min(bytes.byteLength, offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  return new Uint8Array(0);
}

export interface Recording { path: string; seconds: number; pcm: () => Promise<Uint8Array> }
export interface CaptureSession { stop: () => Promise<void>; done: Promise<Recording>; /** The WAV being written (live dictation follows it). */ path?: string }

/** Records the default microphone (or the input `deviceId` names, a CoreAudio device UID; helper only) until `stop()` or
 * `maxSeconds`; `onLevel` hears the 0..1 input level and elapsed seconds. */
async function realStartCapture(options: { maxSeconds: number; deviceId?: string | null; onLevel?: (level: number, seconds: number) => void; onStart?: () => void }): Promise<CaptureSession> {
  const dir = voiceDir();
  const id = desktop().randomId();
  const wav = `${dir}/${id}.wav`, levels = `${dir}/${id}.level.json`, stopFile = `${dir}/${id}.stop`;
  await desktop().mkdir(dir);
  let finished = false;
  let started = false;
  const poll = setInterval(() => {
    void readJson(levels).then((value) => {
      if (finished || !value) return;
      if (!started) { started = true; options.onStart?.(); }
      options.onLevel?.(Number(value.level) || 0, Number(value.seconds) || 0);
    });
  }, 80);
  // The helper records the chosen device (or the default input); without it the JXA recorder takes the default input only.
  const helper = micHelper();
  const args = helper
    ? ["-l", "JavaScript", "-e", HELPER_SCRIPT, helper, "record", wav, levels, stopFile, String(options.maxSeconds), options.deviceId ?? ""]
    : ["-l", "JavaScript", "-e", RECORD_SCRIPT, wav, levels, stopFile, String(options.maxSeconds)];
  const done = desktop().run(OSASCRIPT, args, { timeoutMs: (options.maxSeconds + 30) * 1000 })
    .then(async (output): Promise<Recording> => {
      finished = true;
      clearInterval(poll);
      void desktop().unlink(levels).catch(() => undefined);
      void desktop().unlink(stopFile).catch(() => undefined);
      let result: Record<string, unknown> | null = null;
      try { result = JSON.parse(output.stdout.trim()) as Record<string, unknown>; } catch { result = null; }
      if (output.code !== 0 || !result || typeof result.error === "string") {
        throw Object.assign(new Error("Could not record microphone audio. Try again."), { code: typeof result?.error === "string" ? result.error : "audio-capture" });
      }
      const seconds = Number(result.seconds) || 0;
      if (seconds <= 0) throw Object.assign(new Error("No audio was recorded. Try again."), { code: "no-speech" });
      return { path: wav, seconds, pcm: async () => wavFloat32Data(new Uint8Array(await readFile(wav))) };
    });
  return { stop: () => desktop().writeFile(stopFile, "stop"), done, path: wav };
}

export interface Playback { play: () => Promise<void>; pause: () => Promise<void>; seek: (seconds: number) => Promise<void>; stop: () => Promise<void>; done: Promise<void> }

/** Plays a recording; `onPosition` hears where it is and whether it plays. */
async function realStartPlayback(path: string, onPosition: (current: number, duration: number, playing: boolean) => void): Promise<Playback> {
  const dir = voiceDir();
  const id = desktop().randomId();
  const control = `${dir}/${id}.control`, position = `${dir}/${id}.position.json`;
  await desktop().writeFile(control, "play");
  let finished = false;
  const poll = setInterval(() => {
    void readJson(position).then((value) => { if (!finished && value) onPosition(Number(value.current) || 0, Number(value.duration) || 0, value.playing === true); });
  }, 80);
  const done = desktop().run(OSASCRIPT, ["-l", "JavaScript", "-e", PLAY_SCRIPT, path, control, position], { timeoutMs: null }).then(() => {
    finished = true;
    clearInterval(poll);
    void desktop().unlink(control).catch(() => undefined);
    void desktop().unlink(position).catch(() => undefined);
  });
  const send = (command: string) => desktop().writeFile(control, command);
  return { play: () => send("play"), pause: () => send("pause"), seek: (seconds) => send(`seek:${seconds}`), stop: () => send("stop"), done };
}

export function discardRecording(path: string) {
  if (override) return;
  void desktop().unlink(path).catch(() => undefined);
}

