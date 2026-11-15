// Live dictation (client-runtime/voice-input's controller, on NSH's Speech runtime): the Voice settings gate it
// (`voiceAudioChoice`: unset or "off" opens setup / Voice settings, as the reference's first run does) and shape it
// (`speechLanguage`, `speechRemoveFillerWords`). The system recognizer streams a transcript; it shows as the
// reference's "Live transcription" preview and is inserted at the caret when the person finishes. This engine has no
// microphone level and no choice of destination (it recognizes on this computer), so the waveform is activity-driven.
// Where the client can record audio (desktop/audioCapture.ts), dictation records and sends the clip to the destination
// the person chose in Settings > Voice instead, as the reference does; the system recognizer stays for clients without.
import { signal } from "nsh";

export type VoicePhase = "idle" | "preparing" | "recording" | "transcribing" | "error";
export interface VoiceState { phase: VoicePhase; error: string | null; errorAction: "retry" | "settings" | null }
export const IDLE: VoiceState = { phase: "idle", error: null, errorAction: null };

export const MICROPHONE_PERMISSION_ERROR = "Microphone access is required for voice input. Allow access in your browser or system settings and try again.";

/** VOICE_ERROR_LABELS: the short text the error pill shows; the full message is its tooltip. */
const ERROR_LABELS: Record<string, string> = {
  [MICROPHONE_PERMISSION_ERROR]: "Microphone access needed",
  "Microphone access is required for voice input.": "Microphone access needed",
  "This draft is no longer available.": "Draft unavailable",
  "Another voice recording is already active.": "Another recording active",
  "Voice transcription is not available.": "Voice input unavailable",
  "Voice transcription is still finishing. Try again shortly.": "Transcription still busy",
  "Voice transcription is not available for this language.": "Language unsupported",
  "Could not prepare voice transcription.": "Couldn’t prepare dictation",
  "Could not start voice recording.": "Couldn’t start recording",
  "Voice recording was interrupted.": "Recording interrupted",
  "Could not finish voice recording.": "Couldn’t finish recording",
  "Could not transcribe this recording.": "Transcription failed",
  "Voice transcription on this environment failed.": "Transcription failed",
  "The draft changed while voice input was running. The transcript was not added.": "Draft changed",
  "No speech was detected.": "No speech detected",
  "Microphone processing failed.": "Microphone processing failed",
  "The microphone disconnected.": "Microphone disconnected",
};

/** VoiceInputErrorPill's action label: settings, a retried transcription, or recording again. */
export function voiceErrorActionLabel(error: string | null, action: "retry" | "settings" | null): string {
  if (action === "settings") return "Open voice settings";
  return error === "Could not transcribe this recording." || error === "Voice transcription on this environment failed." ? "Retry transcription" : "Record again";
}
export const voiceErrorLabel = (error: string | null) => (error && ERROR_LABELS[error]) || "Voice input failed";

export type SpeechErrorCode = "not-allowed" | "no-speech" | "audio-capture" | "network" | "language-not-supported" | "unavailable" | "failed";
export function speechError(code: SpeechErrorCode): { error: string; errorAction: "retry" | "settings" } {
  switch (code) {
    case "not-allowed": return { error: MICROPHONE_PERMISSION_ERROR, errorAction: "settings" };
    case "no-speech": return { error: "No speech was detected.", errorAction: "retry" };
    case "audio-capture": return { error: "Could not start voice recording.", errorAction: "retry" };
    case "language-not-supported": return { error: "Voice transcription is not available for this language.", errorAction: "settings" };
    case "unavailable": return { error: "Voice transcription is not available.", errorAction: "settings" };
    default: return { error: "Could not transcribe this recording.", errorAction: "retry" };
  }
}

/** The `speechRemoveFillerWords` switch: "um", "uh", "er", "erm" and "hmm" go, with the comma that followed them. */
export function removeFillerWords(text: string): string {
  return text.replace(/\b(?:um+|uh+|erm?|hmm+)\b[,.]?\s*/gi, "").replace(/\s{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
}

/** The prompt with `transcript` inserted at `caret`, spaced from its neighbours. */
export function insertTranscript(prompt: string, caret: number, transcript: string): { text: string; caret: number } {
  const at = Math.max(0, Math.min(prompt.length, caret));
  const before = prompt.slice(0, at);
  const after = prompt.slice(at);
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trail = after.length > 0 && !/^\s/.test(after) ? " " : "";
  const inserted = `${lead}${transcript}${trail}`;
  return { text: before + inserted + after, caret: before.length + lead.length + transcript.length + trail.length };
}

/** `speechLanguage` as the recognizer's tag: "auto" (and nothing) leave it to the system. */
export const recognizerLanguage = (setting: string): string | null => (setting && setting !== "auto" ? setting : null);

interface SessionLike {
  on(event: "start", listener: () => void): () => void;
  on(event: "result", listener: (result: { text: string; isFinal: boolean }) => void): () => void;
  on(event: "end", listener: (end: { text: string; error?: SpeechErrorCode | null }) => void): () => void;
  stop(): void;
  abort(): void;
}
export interface SpeechLike { available(): Promise<boolean>; start(options?: { lang?: string | null; interim?: boolean | null } | null): SessionLike }

/** VoiceRecorder + the granted destination's transcriber (client-runtime voice-input): records the microphone, then sends
 * the clip as 16 kHz PCM to the environment's model or its cloud provider. */
export interface RecorderLike {
  available(): boolean;
  start(options: { maxSeconds: number; onStart: () => void; onLevel: (level: number, seconds: number) => void }): Promise<{ stop: () => Promise<void>; done: Promise<{ path: string; pcm: () => Promise<Uint8Array> }>; path?: string }>;
  transcribe(pcm: Uint8Array): Promise<string>;
  /** browserVoiceInput's streaming: when the destination streams, a live session the recording's PCM is fed to while it is
   * recorded; its updates are the live preview and `finish` the transcript. Null when it does not stream. */
  live?: (onText: (text: { committed: string; tentative: string }) => void, onError: (error: Error) => void) => Promise<LiveStream | null>;
  /** Reads the recording's PCM written since the last call (the growing WAV). */
  follow?: (path: string) => { poll: () => Promise<Uint8Array> };
  discard(path: string): void;
}

export interface LiveStream { feed: (pcm: Uint8Array) => void; finish: () => Promise<string>; cancel: () => void }

/** VOICE_RECORDING_LIMIT_SECONDS. */
export const VOICE_RECORDING_LIMIT_SECONDS = 5 * 60;

export interface DictationDeps {
  speech: SpeechLike;
  /** Present on a client that can record audio: dictation goes to the person's chosen destination, as the reference's;
   * the system recognizer is used only without it. */
  recorder?: RecorderLike;
  /** `voiceAudioChoice`: whether the person allowed dictation (a grant), turned it off, or never chose. */
  choice: () => "granted" | "off" | "unset";
  language: () => string;
  removeFillers: () => boolean;
  threadId: () => string | undefined;
  prompt: () => string;
  caret: () => number;
  /** Writes the new prompt and caret into the composer. */
  insert: (text: string, caret: number) => void;
  /** First run, or dictation off: Settings > Voice. */
  openSetup: () => void;
}

export interface Dictation {
  state: () => VoiceState;
  /** The transcript so far, committed (final) and tentative. */
  preview: () => { committed: string; tentative: string } | null;
  start(): Promise<void>;
  /** Finish: the recognizer completes what it heard and the transcript is inserted. */
  confirm(): void;
  cancel(): void;
  /** Bumps on every transcript change (the waveform's activity), or every level report while recording audio. */
  activity: () => number;
  /** The microphone's input level 0..1 while recording audio (0 with the system recognizer, which reports none). */
  level?: () => number;
}

/** Test seam: a fixture forces a phase (recording, with a live transcript) without a microphone. */
let dictationFactory: ((deps: DictationDeps) => Dictation) | null = null;
export function setDictationFactoryForTest(factory: ((deps: DictationDeps) => Dictation) | null) { dictationFactory = factory; }
export function makeDictation(deps: DictationDeps): Dictation { return dictationFactory ? dictationFactory(deps) : createDictation(deps); }

export function createDictation(deps: DictationDeps): Dictation {
  const state = signal<VoiceState>(IDLE);
  const preview = signal<{ committed: string; tentative: string } | null>(null);
  const activity = signal(0);
  let session: SessionLike | null = null;
  let startedFor: string | undefined;
  let discard = false;
  let startedCaret = 0;
  const fail = (error: string, errorAction: "retry" | "settings" | null) => { state.set({ phase: "error", error, errorAction }); preview.set(null); session = null; };
  // The recording path: preparing, recording (the level drives the waveform), transcribing, then the transcript.
  let capture: { stop: () => Promise<void> } | null = null;
  let level = 0;
  const recordToDestination = async (recorder: RecorderLike, thread: string) => {
    startedFor = thread; discard = false; startedCaret = deps.caret();
    let started: Awaited<ReturnType<RecorderLike["start"]>>;
    try {
      started = await recorder.start({
        maxSeconds: VOICE_RECORDING_LIMIT_SECONDS,
        onStart: () => { if (!discard) state.set({ phase: "recording", error: null, errorAction: null }); },
        onLevel: (next) => { level = next; activity.update((count) => count + 1); },
      });
    } catch (cause) {
      const code = (cause as { code?: string } | null)?.code;
      fail(code === "not-allowed" || code === "ERR_ACCESS_DENIED" ? MICROPHONE_PERMISSION_ERROR : "Could not start voice recording.", code === "not-allowed" || code === "ERR_ACCESS_DENIED" ? "settings" : "retry");
      return;
    }
    capture = started;
    // Live text: the PCM written so far goes to the destination every 250 ms; its updates are the preview.
    let stream: LiveStream | null = null;
    let streamFailed = false;
    let pumping: ReturnType<typeof setInterval> | null = null;
    const follower = started.path && recorder.follow ? recorder.follow(started.path) : null;
    if (recorder.live && follower) {
      try {
        stream = await recorder.live(
          (text) => { activity.update((count) => count + 1); preview.set({ committed: text.committed, tentative: text.tentative }); },
          () => { streamFailed = true; },
        );
      } catch { stream = null; }
      if (stream) {
        let busy = false;
        pumping = setInterval(() => {
          if (busy || streamFailed) return;
          busy = true;
          void follower.poll().then((pcm) => { if (pcm.byteLength) stream!.feed(pcm); }).finally(() => { busy = false; });
        }, 250);
      }
    }
    const stopPumping = () => { if (pumping) clearInterval(pumping); pumping = null; };
    let recording: { path: string; pcm: () => Promise<Uint8Array> };
    try { recording = await started.done; } catch (cause) {
      capture = null;
      stopPumping();
      stream?.cancel();
      preview.set(null);
      if (discard) { state.set(IDLE); return; }
      const code = (cause as { code?: string } | null)?.code;
      if (code === "no-speech") fail("No speech was detected.", "retry");
      else if (code === "not-allowed") fail(MICROPHONE_PERMISSION_ERROR, "settings");
      else fail("Could not start voice recording.", "retry");
      return;
    }
    capture = null;
    stopPumping();
    if (discard) { stream?.cancel(); preview.set(null); recorder.discard(recording.path); state.set(IDLE); return; }
    state.set({ phase: "transcribing", error: null, errorAction: null });
    let text = "";
    try {
      if (stream && !streamFailed) {
        // The tail written after the last poll, then finish: the stream's final transcript.
        const tail = await follower!.poll();
        if (tail.byteLength) stream.feed(tail);
        text = (await stream.finish()).trim();
      } else {
        stream?.cancel();
        text = (await recorder.transcribe(await recording.pcm())).trim();
      }
    } catch { preview.set(null); recorder.discard(recording.path); if (!discard) fail("Could not transcribe this recording.", "retry"); else state.set(IDLE); return; }
    preview.set(null);
    recorder.discard(recording.path);
    if (discard) { state.set(IDLE); return; }
    if (deps.removeFillers()) text = removeFillerWords(text);
    if (!text) { fail("No speech was detected.", "retry"); return; }
    if (deps.threadId() !== startedFor) { fail("This draft is no longer available.", null); return; }
    const result = insertTranscript(deps.prompt(), Math.min(deps.caret(), deps.prompt().length) || startedCaret, text);
    deps.insert(result.text, result.caret);
    state.set(IDLE);
  };

  return {
    state: () => state(), preview: () => preview(), activity: () => activity(),
    async start() {
      if (state().phase !== "idle" && state().phase !== "error") return;
      if (deps.choice() !== "granted") { state.set(IDLE); deps.openSetup(); return; }
      const thread = deps.threadId();
      if (!thread) { fail("This draft is no longer available.", null); return; }
      state.set({ phase: "preparing", error: null, errorAction: null });
      if (deps.recorder?.available()) { await recordToDestination(deps.recorder, thread); return; }
      let available = false;
      try { available = await deps.speech.available(); } catch { available = false; }
      if (!available) { fail("Voice transcription is not available.", "settings"); return; }
      startedFor = thread; discard = false; startedCaret = deps.caret();
      let opened: SessionLike;
      try { opened = deps.speech.start({ lang: recognizerLanguage(deps.language()), interim: true }); } catch (cause) {
        const denied = typeof cause === "object" && cause !== null && (cause as { code?: string }).code === "ERR_ACCESS_DENIED";
        fail(denied ? MICROPHONE_PERMISSION_ERROR : "Could not start voice recording.", denied ? "settings" : "retry"); return;
      }
      session = opened;
      opened.on("start", () => { if (session === opened) state.set({ phase: "recording", error: null, errorAction: null }); });
      let finalText = "";
      opened.on("result", (result) => {
        if (session !== opened) return;
        activity.update((count) => count + 1);
        // The recognizer reports the whole transcript so far; only its final part is committed.
        if (result.isFinal) { finalText = result.text; preview.set({ committed: result.text, tentative: "" }); }
        else preview.set({ committed: finalText, tentative: result.text.startsWith(finalText) ? result.text.slice(finalText.length) : result.text });
      });
      opened.on("end", (end) => {
        if (session !== opened) return;
        session = null;
        preview.set(null);
        if (discard) { state.set(IDLE); return; }
        if (end.error) { const mapped = speechError(end.error); fail(mapped.error, mapped.errorAction); return; }
        let text = end.text.trim();
        if (deps.removeFillers()) text = removeFillerWords(text);
        if (!text) { fail("No speech was detected.", "retry"); return; }
        if (deps.threadId() !== startedFor) { fail("This draft is no longer available.", null); return; }
        const result = insertTranscript(deps.prompt(), Math.min(deps.caret(), deps.prompt().length) || startedCaret, text);
        deps.insert(result.text, result.caret);
        state.set(IDLE);
      });
    },
    confirm() {
      if (capture && state().phase === "recording") { state.set({ phase: "transcribing", error: null, errorAction: null }); void capture.stop(); return; }
      if (session && state().phase === "recording") { state.set({ phase: "transcribing", error: null, errorAction: null }); session.stop(); }
    },
    cancel() {
      if (state().phase === "error") { state.set(IDLE); return; }
      discard = true;
      if (capture) { void capture.stop(); return; }
      if (session) session.abort(); else state.set(IDLE);
    },
    level: () => level,
  };
}
