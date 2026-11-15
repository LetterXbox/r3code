// The dictation control (chat/ComposerSpeechButton.tsx): an icon-sm ghost button with a microphone,
// "Start voice input" and its shortcut as the tooltip. Where speech is not set up the web offers the
// first-run setup from this same button (VoiceInputSetup, which links to Settings > Voice); the button
// here opens that panel. The recording, transcribing and error pills belong to the speech engine, which
// this app does not have yet: its state is always idle, and the button hides when a state would show a pill.
import { View } from "nsh";
import { ComposerIcon } from "./ComposerIcon";

export type VoiceInputPhase = "idle" | "error" | "preparing" | "recording" | "transcribing" | "post-processing";
export interface VoiceInputState { phase: VoiceInputPhase; error?: string }

export interface SpeechPresentation { status: string | null; showsCancel: boolean; showsConfirm: boolean; confirmEnabled: boolean; showsSend: boolean }

/** resolveSpeechPresentation: what the voice control shows for each phase. */
export function resolveSpeechPresentation(state: VoiceInputState, progress: { downloaded: number; total: number } | null = null): SpeechPresentation {
  const busy = (status: string, confirmEnabled = false): SpeechPresentation => ({ status, showsCancel: true, showsConfirm: true, confirmEnabled, showsSend: true });
  switch (state.phase) {
    case "idle": return { status: null, showsCancel: false, showsConfirm: false, confirmEnabled: false, showsSend: true };
    case "error": return { status: state.error ?? "Voice input failed", showsCancel: false, showsConfirm: false, confirmEnabled: false, showsSend: true };
    case "preparing": return busy(progress ? `Downloading speech model ${Math.round((progress.downloaded / Math.max(1, progress.total)) * 100)}%` : "Preparing");
    case "recording": return busy("Recording", true);
    case "transcribing": return busy("Transcribing");
    case "post-processing": return busy("Post-processing");
  }
}

export const IDLE_VOICE_STATE: VoiceInputState = { phase: "idle" };

export function ComposerSpeechButton(props: { shortcutLabel: string | null; disabled?: boolean; state?: VoiceInputState; onStart: () => void }) {
  const label = "Start voice input";
  const presentation = () => resolveSpeechPresentation(props.state ?? IDLE_VOICE_STATE);
  return (
    <>
      {presentation().showsConfirm || (props.state ?? IDLE_VOICE_STATE).phase === "error" ? null : (
        <View
          class={`size-7 items-center justify-center rounded-md hover:bg-accent ${props.disabled ? "opacity-64" : ""}`}
          tooltip={`${label}${props.shortcutLabel ? ` (${props.shortcutLabel})` : ""}`}
          disabled={props.disabled === true}
          onPress={() => { if (!props.disabled) props.onStart(); }}
          accessibilityLabel={label}
          role="button"
        >
          <ComposerIcon name="mic" size={16} />
        </View>
      )}
    </>
  );
}
