// MicrophoneTest.tsx: the ten-second microphone check beside the Microphone select: record, meter the input level,
// then play the clip back (Play/Pause, position), Record again or Done. The web records with getUserMedia; this client
// records through desktop/audioCapture.ts (AVFoundation via osascript on macOS), which keeps the clip in the app's data
// directory and never transcribes it, as the row promises. Without capture (another OS) it takes the reference's
// capture-unavailable path. The driver seam lets tests play the session's events.
import { effect, signal, Text, View } from "nsh";
import { MICROPHONE_PERMISSION_ERROR } from "./speech";
import { PillIconButton, VoicePill } from "./VoiceControls";
import { PillButton } from "../providers/ui";
import { VoiceIcon } from "./VoiceIcon";
import { voiceMicrophone } from "./voiceState";
import { canCaptureAudio, discardRecording, startCapture, startPlayback, type CaptureSession } from "../../../desktop/audioCapture";
import { Slider } from "nsh/base";

export const LOOPBACK_SECONDS = 10;
const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
export const MICROPHONE_UNAVAILABLE = "Microphone testing is unavailable in this browser. Use HTTPS or the desktop app.";

/** VOICE_ERROR_LABELS in chat/VoiceInputErrorPill.tsx: the short label the pill shows for a long message. */
const ERROR_LABELS: Record<string, string> = {
  [MICROPHONE_PERMISSION_ERROR]: "Microphone access needed",
  "The microphone disconnected.": "Microphone disconnected",
};
export const errorPillLabel = (error: string) => ERROR_LABELS[error] ?? "Voice input failed";

export interface MicrophoneSession {
  on(event: "start", listener: () => void): unknown;
  on(event: "level", listener: (level: number) => void): unknown;
  on(event: "end", listener: (end: { text: string; error?: string | null; recording?: { path: string; seconds: number } }) => void): unknown;
  stop(): void;
  abort(): void;
}
export interface MicrophonePlayer { play(): void; pause(): void; seek(seconds: number): void; stop(): void }
export interface MicrophoneDriver {
  available: () => Promise<boolean>;
  start: () => MicrophoneSession;
  /** Plays a finished recording; `onPosition` hears where it is. Resolves the player once it started. */
  play?: (path: string, onPosition: (current: number, duration: number, playing: boolean) => void, onEnded: () => void) => Promise<MicrophonePlayer>;
  discard?: (path: string) => void;
}

/** The capture driver: desktop/audioCapture.ts behind the session events the test reads. */
function captureDriver(): MicrophoneDriver {
  return {
    available: () => Promise.resolve(canCaptureAudio()),
    start: () => {
      const listeners: { start: (() => void)[]; level: ((level: number) => void)[]; end: ((end: any) => void)[] } = { start: [], level: [], end: [] };
      let session: CaptureSession | null = null;
      let aborted = false;
      void startCapture({ maxSeconds: LOOPBACK_SECONDS + 1, deviceId: voiceMicrophone() || null, onStart: () => listeners.start.forEach((l) => l()), onLevel: (level) => listeners.level.forEach((l) => l(level)) }).then((current) => {
        session = current;
        if (aborted) void current.stop();
        current.done.then((recording) => {
          if (aborted) { discardRecording(recording.path); return; }
          listeners.end.forEach((l) => l({ text: "", recording: { path: recording.path, seconds: recording.seconds } }));
        }, (cause: { code?: string }) => { if (!aborted) listeners.end.forEach((l) => l({ text: "", error: cause?.code ?? "audio-capture" })); });
      }, () => listeners.end.forEach((l) => l({ text: "", error: "audio-capture" })));
      return {
        on(event: "start" | "level" | "end", listener: any) { listeners[event].push(listener); return () => undefined; },
        stop: () => { void session?.stop(); },
        abort: () => { aborted = true; void session?.stop(); },
      } as MicrophoneSession;
    },
    play: async (path, onPosition, onEnded) => {
      const playback = await startPlayback(path, onPosition);
      void playback.done.then(onEnded);
      return { play: () => void playback.play(), pause: () => void playback.pause(), seek: (seconds) => void playback.seek(seconds), stop: () => void playback.stop() };
    },
    discard: discardRecording,
  };
}

let driver: MicrophoneDriver = captureDriver();
/** Tests swap the recognizer; the app never calls this. */
export function configureMicrophoneTest(next: Partial<MicrophoneDriver>) {
  driver = { ...driver, ...next };
}

/** What a session's `error` means in the reference's copy. */
export function microphoneError(code: string | null | undefined): string | null {
  switch (code) {
    case undefined:
    case null:
    case "":
      return null;
    case "not-allowed": return MICROPHONE_PERMISSION_ERROR;
    case "audio-capture": return "Could not record microphone audio. Try again.";
    case "unavailable": return MICROPHONE_UNAVAILABLE;
    case "no-speech": return "No audio was recorded. Try again.";
    default: return "Could not access the microphone.";
  }
}

export function MicrophoneTest() {
  const phase = signal<"idle" | "starting" | "recording" | "ready">("idle");
  const error = signal<string | null>(null);
  const elapsed = signal(0);
  const level = signal(0);
  const recording = signal<{ path: string; seconds: number } | null>(null);
  let session: MicrophoneSession | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const forget = () => {
    const current = recording();
    recording.set(null);
    if (current) driver.discard?.(current.path);
  };
  const release = () => {
    if (timer) clearInterval(timer);
    timer = null;
    const current = session;
    session = null;
    if (current) { try { current.abort(); } catch { /* already ended */ } }
  };
  // Leaving the page releases the microphone and drops the clip.
  effect(() => () => { release(); forget(); });

  const start = async () => {
    release();
    forget();
    error.set(null);
    elapsed.set(0);
    level.set(0);
    phase.set("starting");
    let available = false;
    try { available = await driver.available(); } catch { available = false; }
    if (!available) { error.set(MICROPHONE_UNAVAILABLE); phase.set("idle"); return; }
    try {
      const current = driver.start();
      session = current;
      current.on("start", () => {
        if (session !== current || phase() === "recording") return;
        const startedAt = Date.now();
        phase.set("recording");
        timer = setInterval(() => {
          const seconds = Math.min(LOOPBACK_SECONDS, Math.floor((Date.now() - startedAt) / 1000));
          elapsed.set(seconds);
          if (seconds >= LOOPBACK_SECONDS) current.stop();
        }, 100);
      });
      current.on("level", (next) => { if (session === current) level.set(next); });
      current.on("end", (end) => {
        if (session !== current) return;
        session = null;
        if (timer) clearInterval(timer);
        timer = null;
        const failure = microphoneError(end.error ?? null);
        if (failure) { error.set(failure); phase.set("idle"); return; }
        recording.set(end.recording ?? null);
        phase.set("ready");
      });
    } catch (cause) {
      release();
      const code = (cause as { code?: string } | null)?.code;
      error.set(code === "ERR_ACCESS_DENIED" ? MICROPHONE_PERMISSION_ERROR : cause instanceof Error ? cause.message : "Could not access the microphone.");
      phase.set("idle");
    }
  };
  const cancel = () => { release(); forget(); error.set(null); phase.set("idle"); };

  return (
    <View testID={`Microphone test (${error() ? "error" : phase()})`}>
      {error() ? (
        <VoicePill>
          <PillIconButton label="Dismiss voice input error" icon="x" onPress={cancel} />
          <Text accessibilityLabel={error() ?? ""} class="min-w-0 flex-1 truncate text-sm text-destructive-foreground">{errorPillLabel(error() ?? "")}</Text>
          <PillIconButton label="Record again" icon="rotate-ccw" onPress={() => void start()} />
        </VoicePill>
      ) : phase() === "idle" ? (
        <PillButton label="Test microphone" size="xs" onPress={() => void start()}>
          <VoiceIcon name="mic" size={14} />
          <Text class="text-sm text-foreground">Test microphone</Text>
        </PillButton>
      ) : phase() === "ready" ? (
        recording() && driver.play
          ? <MicrophonePlayback recording={recording()!} onRetry={() => void start()} onDone={cancel} />
          : (
            <VoicePill>
              <View class="min-w-0 flex-1" accessibilityLabel="Microphone test finished" />
              <PillIconButton label="Record again" icon="rotate-ccw" onPress={() => void start()} />
              <PillIconButton label="Done" icon="check" primary onPress={cancel} />
            </VoicePill>
          )
      ) : (
        <VoicePill>
          <PillIconButton label="Cancel microphone test" icon="x" onPress={cancel} />
          {phase() === "recording" ? (
            <>
              <LevelBars level={level} />
              <View class="size-1.5 shrink-0 rounded-full bg-primary" />
              <Text accessibilityLabel="Recording time" class="shrink-0 text-xs text-muted-foreground">{`${formatTime(elapsed())} / ${formatTime(LOOPBACK_SECONDS)}`}</Text>
            </>
          ) : (
            <Text class="min-w-0 flex-1 truncate text-xs text-muted-foreground">Opening microphone…</Text>
          )}
          <PillIconButton label="Stop recording" icon="check" primary disabled={phase() !== "recording"} onPress={() => session?.stop()} />
        </VoicePill>
      )}
    </View>
  );
}

/** VoiceWaveform: bars that follow the input level. */
function LevelBars(props: { level: () => number }) {
  const heights = [0.45, 0.8, 1, 0.7, 0.5, 0.9, 0.6];
  return (
    <View class="h-4 min-w-0 flex-1 flex-row items-center gap-0.5" accessibilityLabel="Microphone input level" accessibilityValue={{ min: 0, max: 1, now: props.level() }}>
      {heights.map((weight) => <View class="w-0.5 rounded-full bg-foreground" style={{ height: Math.max(2, 16 * weight * Math.min(1, props.level())) }} />)}
    </View>
  );
}

/** MicrophonePlayback: Play/Pause, the position slider and time, Record again and Done. */
function MicrophonePlayback(props: { recording: { path: string; seconds: number }; onRetry: () => void; onDone: () => void }) {
  const playing = signal(false);
  const position = signal(0);
  const failed = signal(false);
  let player: MicrophonePlayer | null = null;
  let ended = true;
  const duration = props.recording.seconds;
  effect(() => () => { player?.stop(); player = null; });
  const toggle = async () => {
    if (playing()) { player?.pause(); playing.set(false); return; }
    failed.set(false);
    if (player && !ended) { player.play(); playing.set(true); return; }
    try {
      ended = false;
      player = await driver.play!(props.recording.path, (current, _total, nowPlaying) => { position.set(current); playing.set(nowPlaying); },
        () => { ended = true; player = null; playing.set(false); });
      playing.set(true);
    } catch {
      ended = true;
      failed.set(true);
    }
  };
  return (
    <View class="gap-1">
      <VoicePill>
        <PillIconButton label={playing() ? "Pause recording" : "Play recording"} icon={playing() ? "pause" : "play"} onPress={() => void toggle()} />
        <Slider
          accessibilityLabel="Recording playback position"
          value={Math.min(position(), duration)}
          min={0}
          max={Math.max(duration, 0.01)}
          step={0.01}
          disabled={duration <= 0}
          onChange={(event: { value: number | [number, number] }) => { const next = Array.isArray(event.value) ? event.value[0] : event.value; position.set(next); player?.seek(next); }}
          class="h-4 min-w-0 flex-1"
          trackClass="h-1 rounded-full bg-muted"
          rangeClass="h-1 rounded-full bg-primary"
          thumbClass="size-2.5 rounded-full bg-primary"
        />
        <Text class="shrink-0 text-xs text-muted-foreground">{formatTime(position())}</Text>
        <PillIconButton label="Record again" icon="rotate-ccw" onPress={props.onRetry} />
        <PillIconButton label="Done" icon="check" primary onPress={props.onDone} />
      </VoicePill>
      {failed() ? <Text role="alert" class="text-xs text-destructive-foreground">Could not play this recording. Try recording again.</Text> : null}
    </View>
  );
}
