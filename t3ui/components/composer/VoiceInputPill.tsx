// The dictation pill (chat/VoiceInputPill.tsx, ComposerSpeechButton's recording pill, VoiceInputErrorPill.tsx):
// a 28pt-tall, 256pt-wide row in the footer, so starting a recording never resizes the composer. Recording shows
// cancel, the waveform, a dot, the elapsed time and finish; the other phases a status; an error its short label
// with dismiss and retry / Voice settings. The recognizer reports no microphone level, so the bars follow the
// transcript's activity (a port-specific stand-in for the level meter).
import { cleanup, reduceMotion, Scroll, signal, Text, token, View } from "nsh";
import { Spinner } from "../sidebar/Spinner";
import { Image } from "nsh";
import rotateCcw from "../../icons/rotate-ccw.svg";
import { ComposerIcon } from "./ComposerIcon";
import { voiceErrorActionLabel, voiceErrorLabel } from "./dictation";
import type { Dictation } from "./dictation";

const BARS = 28;

export const formatElapsed = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

function Waveform(props: { activity: () => number; level?: () => number }) {
  const levels = signal<number[]>(Array<number>(BARS).fill(0));
  let seen = props.activity();
  const timer = setInterval(() => {
    const now = props.activity();
    const fresh = now !== seen;
    seen = now;
    // A recording reports the microphone level (VoiceWaveform's level); the system recognizer only its activity.
    const measured = props.level?.() ?? 0;
    levels.update((list) => [...list.slice(1), measured > 0 ? Math.min(1, measured) : fresh ? 0.55 + Math.random() * 0.45 : (list[list.length - 1] ?? 0) * 0.7]);
  }, 100);
  cleanup(() => clearInterval(timer));
  return (
    <View class="h-5 min-w-0 flex-1 flex-row items-center justify-between gap-px overflow-hidden">
      {levels().map((level) => (
        // VoiceWaveform: each bar scaleY(max(0.08, level)) of h-5, so a quiet microphone reads as a dotted line; the
        // height is set directly (a centred bar of that height) rather than through a transform.
        <View class="w-0.5 shrink-0 rounded-full bg-primary" style={{ opacity: 0.22 + level * 0.78, height: Math.max(1.6, 20 * (reduceMotion() ? 0.35 : Math.max(0.08, level))) }} />
      ))}
    </View>
  );
}

function PillButton(props: { label: string; onPress: () => void; disabled?: boolean; primary?: boolean; children?: any }) {
  return (
    <View
      // Button size="icon-sm-pill": a 28pt circle; the finish button is the default (primary) variant, the rest ghost.
      class={`size-7 shrink-0 items-center justify-center rounded-full ${props.primary ? "bg-primary shadow-sm hover:opacity-90" : "hover:bg-accent"} ${props.disabled ? "opacity-64" : ""}`}
      tooltip={props.label}
      accessibilityLabel={props.label}
      role="button"
      disabled={props.disabled === true}
      onPress={() => { if (!props.disabled) props.onPress(); }}
    >
      {props.children}
    </View>
  );
}

function Elapsed() {
  const seconds = signal(0);
  const startedAt = Date.now();
  const timer = setInterval(() => seconds.set(Math.floor((Date.now() - startedAt) / 1000)), 250);
  cleanup(() => clearInterval(timer));
  return <Text class="shrink-0 text-xs text-muted-foreground" style={{ fontVariant: ["tabular-nums"] }}>{formatElapsed(seconds())}</Text>;
}

/** Nothing while idle; otherwise the pill for the dictation's phase. */
export function VoiceInputPill(props: { dictation: Dictation; cancelShortcutLabel?: string | null; onOpenSettings: () => void; onRetry?: () => void }) {
  const d = props.dictation;
  const cancelLabel = () => `${d.state().phase === "error" ? "Dismiss voice input error" : "Cancel voice input"}${props.cancelShortcutLabel ? ` (${props.cancelShortcutLabel})` : ""}`;
  return (
    <>
      {d.state().phase === "idle" ? null : (
        <View class="h-7 w-64 min-w-0 shrink-0 flex-row items-center gap-2" testID="voice-input-pill">
          <PillButton label={cancelLabel()} onPress={() => d.cancel()}><ComposerIcon name="x" size={16} /></PillButton>
          {d.state().phase === "error" ? (
            <>
              <Text class="min-w-0 flex-1 text-sm text-destructive" tooltip={d.state().error ?? "Voice input failed"} accessibilityLabel={d.state().error ?? "Voice input failed"}>{voiceErrorLabel(d.state().error)}</Text>
              {d.state().errorAction === "settings"
                ? <PillButton label="Open voice settings" onPress={() => { d.cancel(); props.onOpenSettings(); }}><ComposerIcon name="settings" size={16} /></PillButton>
                : d.state().errorAction === "retry"
                  ? <PillButton label={voiceErrorActionLabel(d.state().error, "retry")} onPress={() => (props.onRetry ? props.onRetry() : void d.start())}><Image src={rotateCcw} style={{ width: 16, height: 16 }} /></PillButton>
                  : null}
            </>
          ) : d.state().phase === "recording" ? (
            <>
              <Waveform activity={d.activity} {...(d.level ? { level: d.level } : {})} />
              <View class="size-1.5 shrink-0 rounded-full bg-primary" />
              <Elapsed />
              <PillButton label="Finish voice input" primary onPress={() => d.confirm()}><ComposerIcon name="check" size={16} tint={String(token("primary-foreground"))} /></PillButton>
            </>
          ) : (
            <>
              <Text class="min-w-0 flex-1 truncate text-right text-sm text-muted-foreground">{d.state().phase === "transcribing" ? "Transcribing" : "Preparing"}</Text>
              <PillButton label="Voice input is busy" primary onPress={() => {}} disabled><Spinner size={14} tint={String(token("primary-foreground"))} /></PillButton>
            </>
          )}
        </View>
      )}
    </>
  );
}

/** The live transcription box above the footer: committed text, then the tentative tail dimmed. */
export function LiveTranscription(props: { dictation: Dictation }) {
  const preview = () => props.dictation.preview();
  return (
    <>
      {preview() ? (
        // max-h-32 overflow-y-auto: a long transcript scrolls inside the box instead of running past the composer.
        <Scroll class="mx-4 mb-3 max-h-32 shrink-0 rounded-lg border border-border-60 bg-muted-30" accessibilityLabel="Live transcription">
          <View class="px-3 py-2">
            <Text class="text-sm leading-relaxed text-foreground">{preview()!.committed}<Text class="text-muted-foreground">{preview()!.tentative}</Text></Text>
          </View>
        </Scroll>
      ) : null}
    </>
  );
}
