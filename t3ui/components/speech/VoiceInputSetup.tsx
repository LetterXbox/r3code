// "Set up voice input" (chat/VoiceInputSetup.tsx + ui/wizard): a two-step modal, Model then Ready to dictate. Step 1
// offers the model chosen for the person's language with its size and the Silero note, downloads it with progress
// and cancel; step 2 offers to start dictating. Mounted once by the composer; `openVoiceInputSetup` opens it.
import { SETTINGS_WRITE_SCOPE, scopeAllows } from "../../backend/sessionScopes";
import { cleanup, signal, Text, View } from "nsh";
import { SettingsDialog } from "../SettingsDialog";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { PillButton } from "../../pages/settings/providers/ui";
import { languageLabel } from "../../pages/settings/voice/speech";
import { openSettings } from "../../store";
import { setupEnvironmentLabel, voiceSetup } from "./voiceSetup";
import type { SetupState, VoiceSetup } from "./voiceSetup";

// The composer and the Voice settings page both mount the dialog; only the first mounted one draws it.
const hosts = signal<symbol[]>([]);

export const setupProgress = (model: SetupState["model"]): number | null =>
  model?.downloaded === undefined || model.size <= 0 ? null : Math.round((model.downloaded / model.size) * 100);

export const downloadButtonLabel = (state: SetupState) => state.downloading ? "Downloading…" : state.error ? "Try again" : "Download model";

function Steps(props: { current: number }) {
  const labels = ["Model", "Ready to dictate"];
  return (
    <View class="flex-row gap-1 rounded-xl bg-muted-40 p-1" accessibilityLabel="Steps">
      {labels.map((label, index) => (
        <View class={`h-9 flex-1 flex-row items-center gap-2 rounded-lg px-3 ${props.current === index ? "bg-card" : ""}`} accessibilityLabel={`Step ${index + 1}: ${label}${props.current === index ? " (current)" : ""}`}>
          <View class={`size-5 items-center justify-center rounded-full border ${props.current === index ? "border-primary" : "border-border"}`}>
            <Text class={`text-xs ${props.current === index ? "text-foreground" : "text-muted-foreground"}`}>{String(index + 1)}</Text>
          </View>
          <Text class={`text-sm ${props.current === index ? "text-foreground" : "text-muted-foreground"}`}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

export function VoiceInputSetup(props: { setup?: VoiceSetup; environmentLabel?: () => string }) {
  const setup = props.setup ?? voiceSetup;
  const me = Symbol("voice setup host");
  hosts.update((list) => [...list, me]);
  cleanup(() => hosts.update((list) => list.filter((item) => item !== me)));
  const hosting = () => props.setup !== undefined || hosts()[0] === me;
  const environment = props.environmentLabel ?? setupEnvironmentLabel;
  const state = () => setup.state();
  useOverlayOpen(() => state().open, "voice input setup");
  const goToSettings = () => { setup.setOpen(false); openSettings("/settings/voice"); };
  const progress = () => setupProgress(state().model);
  const body = () => {
    const current = state();
    const model = current.model;
    if (current.step === 1) {
      return (
        <View class="gap-4">
          <View class="gap-2">
            <Text class="text-sm font-medium text-foreground">Microphone</Text>
            <View class="h-8 w-full justify-center rounded-lg border border-input bg-background px-3"><Text class="text-sm text-foreground">System default</Text></View>
          </View>
          <Text class="text-sm text-muted-foreground">Speak and transcribe in multiple languages or translate into English, and get names and technical terms right with the dictionary in Voice settings.</Text>
        </View>
      );
    }
    return (
      <View class="gap-3">
        {model ? (
          <View class="gap-2 rounded-lg border border-border-60 bg-card-40 p-4">
            <View class="flex-row items-center justify-between gap-2">
              <Text class="min-w-0 flex-1 text-sm font-medium text-foreground">{model.name}</Text>
              {model.recommended && current.language ? <Text class="shrink-0 text-xs font-medium text-primary">{`Recommended for ${languageLabel(current.language)}`}</Text> : null}
            </View>
            <Text class="text-sm text-muted-foreground">{`Download the ${Math.round(model.size / 1024 / 1024)} MB model to ${environment()}. Microphone audio is sent there for transcription, as chosen in Voice settings.`}</Text>
            <Text class="text-sm text-muted-foreground">Silero (1.2 MB), used for silence filtering and pause detection, downloads alongside the speech model. An installed copy is reused.</Text>
            {current.downloading ? (
              <View class="gap-1" accessibilityLabel="Speech model download progress">
                <View class="h-1 overflow-hidden rounded-full bg-muted"><View class="h-full bg-primary" style={{ width: `${progress() ?? 0}%` }} /></View>
                <Text class="text-xs text-muted-foreground">{model.state === "verifying" ? "Verifying download…" : progress() === null ? "Starting download…" : `${progress()}% downloaded`}</Text>
              </View>
            ) : null}
          </View>
        ) : !current.error ? <Text class="text-sm text-muted-foreground">Loading transcription models…</Text> : null}
        {current.error ? <Text class="text-sm text-destructive-foreground" role="alert">{current.error}</Text> : null}
      </View>
    );
  };
  const footer = () => {
    const current = state();
    if (current.step === 1) {
      return (
        <>
          <PillButton label="Customize in Voice settings" onPress={goToSettings}><Text class="text-sm text-foreground">Customize in Voice settings</Text></PillButton>
          <PillButton label="Start dictating" variant="primary" onPress={() => setup.startRecording()}><Text class="text-sm text-primary-foreground">Start dictating</Text></PillButton>
        </>
      );
    }
    return (
      <>
        <PillButton label={current.model ? "Choose another model or language" : "Choose a model or language"} onPress={goToSettings}><Text class="text-sm text-foreground">{current.model ? "Choose another model or language" : "Choose a model or language"}</Text></PillButton>
        {current.catalogFailed && current.status?.supported ? <PillButton label="Retry loading models" variant="primary" onPress={() => void setup.retryCatalog()}><Text class="text-sm text-primary-foreground">Retry loading models</Text></PillButton> : null}
        {current.downloading ? <PillButton label="Cancel download" disabled={!scopeAllows(SETTINGS_WRITE_SCOPE)} onPress={() => void setup.cancelDownload()}><Text class="text-sm text-foreground">Cancel download</Text></PillButton> : null}
        {current.model ? (
          // VoiceInputSetup canManage: without settings:write the action asks for an admin instead.
          <PillButton label={scopeAllows(SETTINGS_WRITE_SCOPE) ? downloadButtonLabel(current) : "Ask an environment admin to download"} variant="primary" disabled={!scopeAllows(SETTINGS_WRITE_SCOPE) || current.downloading || !current.status} onPress={() => void setup.download()}>
            <Text class="text-sm text-primary-foreground">{scopeAllows(SETTINGS_WRITE_SCOPE) ? downloadButtonLabel(current) : "Ask an environment admin to download"}</Text>
          </PillButton>
        ) : null}
      </>
    );
  };
  return (
    <SettingsDialog
      open={state().open && hosting()} onClose={() => setup.setOpen(false)} width={576} testID="Voice input setup"
      title="Set up voice input" description={`Transcribe speech on ${environment()} and use voice input across environments.`}
      footer={footer()}
    >
      <Steps current={state().step} />
      {body()}
    </SettingsDialog>
  );
}
