// Settings > Voice, ported from VoiceSettingsPanel.tsx for a desktop client: Input (microphone, dictation
// shortcut), Transcription ("Transcribe with", language, translate, the model browser, hardware and unloading),
// Transcription options (silence, filler words, dictionaries) and Cleanup. Conditional rows follow the
// reference's conditions; data and actions go through the environment's voice HTTP API (voiceApi.ts).
import { Text, View, computed, effect, signal } from "nsh";
import { SettingsSection, SettingsSwitch } from "../../../components/SettingsLayout";
import { ModelSelectionControl } from "../ModelSelectionControl";
import { AdvancedFold } from "../AdvancedFold";
import { DraftInput, Row } from "../providers/ui";
import { readSetting, writeSetting } from "../settingsSync";
import { canCaptureAudio, discardRecording, listMicrophones, startCapture, type CaptureSession, type Microphone } from "../../../desktop/audioCapture";
import { microphoneError, MICROPHONE_UNAVAILABLE } from "./MicrophoneTest";
import { VoiceIcon } from "./VoiceIcon";
import { PillButton } from "../providers/ui";
import { transcribeSpeechPcm } from "./voiceApi";
import { registerSettingsRow, rowTargetId, settingsTarget } from "../settingsSearchNav";
import { CloudVoiceDialog } from "./CloudVoiceDialog";
import { MicrophoneTest } from "./MicrophoneTest";
import { VoiceInputSetup } from "../../../components/speech/VoiceInputSetup";
import { ModelBrowser } from "./ModelBrowser";
import {
  DEFAULT_SPEECH_POST_PROCESSING_PROMPT, OFF, SHORTCUT_MODE_LABELS, SYSTEM_DEFAULT, UNLOAD_LABELS, accelerationLabel,
  cloudSpeechLanguages, destinationLabel, destinationOptions, destinationValue, entryCountLabel, languageLabel, languageSelectView,
  type CloudSpeechProvider, type EnvironmentSpeechStatus, type SpeechModelUnloadTimeout, type VoiceShortcutMode, type VoiceTranscriptionDestination,
} from "./speech";
import { createVoiceCatalog } from "./voiceCatalog";
import { updateSpeechAcceleration, updateSpeechModelUnloadTimeout, voiceConnected } from "./voiceApi";
import {
  audioGrant, chooseAudioDestination, chooseTranscriptCleanup, cleanupEnabled, connectedEnvironments, correctionCue, postProcessingPrompt,
  projectCustomWords, setPostProcessingPrompt, setProjectCustomWords, setSpeechCustomWords, setSpeechLanguage, speechCustomWords, speechLanguage, voiceMicrophone,
} from "./voiceState";
import { DictionaryEditor, TextArea, VoiceIconButton, VoiceSelect } from "./VoiceControls";

export const VOICE_PATH = "/settings/voice";

const clientBool = (field: string, fallback: boolean) => { const value = readSetting(field, "client"); return typeof value === "boolean" ? value : fallback; };
const setClient = (field: string, value: string | boolean) => void writeSetting(field, "client", value);

function preferredLanguages(): string[] {
  try {
    const tags = (globalThis as { navigator?: { languages?: readonly string[] } }).navigator?.languages ?? [];
    const codes = tags.map((tag) => tag.toLowerCase().split(/[-_]/)[0] ?? "");
    return codes.length ? codes : ["en"];
  } catch {
    return ["en"];
  }
}

/** A Row that a settings search result can scroll to and highlight. */
function VoiceRow(props: { id: string | null; title: string; description?: string; control?: any; children?: any; first?: boolean }) {
  const key = () => rowTargetId(VOICE_PATH, props.id, props.title);
  const isTarget = () => settingsTarget()?.path === VOICE_PATH && settingsTarget()?.id === key();
  return (
    <View ref={(node: any) => registerSettingsRow(VOICE_PATH, key(), node)} testID={`Settings row ${key()} (${isTarget() ? "target" : "idle"})`} class={isTarget() ? "bg-accent-50" : undefined}>
      <Row title={props.title} description={props.description} control={props.control} divider={props.first === true ? false : true}>{props.children}</Row>
    </View>
  );
}

function ClientSwitch(props: { label: string; field: string; fallback: boolean; disabled?: boolean }) {
  return props.disabled
    ? <View class="opacity-64"><SettingsSwitch label={props.label} checked={clientBool(props.field, props.fallback)} onChange={() => undefined} /></View>
    : <SettingsSwitch label={props.label} checked={clientBool(props.field, props.fallback)} onChange={(next) => setClient(props.field, next)} />;
}

/** The model card's "Test model": record (desktop/audioCapture.ts), send the clip to the environment's selected model with
 * cleanup skipped, and show what it heard. Without capture or a supporting environment it says why, as the reference does. */
function TranscriptionTest(props: { status: EnvironmentSpeechStatus | null }) {
  const phase = signal<"idle" | "starting" | "recording" | "transcribing">("idle");
  const open = signal(false);
  const transcript = signal<string | null>(null);
  const failure = signal<string | null>(null);
  const level = signal(0);
  const elapsed = signal(0);
  let session: CaptureSession | null = null;
  let cancelled = false;
  effect(() => () => { cancelled = true; void session?.stop(); });
  const available = () => props.status?.supported === true && voiceConnected() && canCaptureAudio();
  const start = async () => {
    cancelled = false;
    open.set(true);
    transcript.set(null);
    failure.set(null);
    phase.set("starting");
    try {
      const current = await startCapture({ maxSeconds: 300, deviceId: voiceMicrophone() || null, onStart: () => phase.set("recording"), onLevel: (next, seconds) => { level.set(next); elapsed.set(Math.floor(seconds)); } });
      session = current;
      const recording = await current.done;
      session = null;
      if (cancelled) { discardRecording(recording.path); return; }
      phase.set("transcribing");
      const pcm = await recording.pcm();
      discardRecording(recording.path);
      const text = await transcribeSpeechPcm(pcm, {
        speechLanguage: speechLanguage(),
        speechTranslateToEnglish: clientBool("speechTranslateToEnglish", false),
        speechCustomWords: [...speechCustomWords(), ...projectCustomWords()],
        speechRemoveFillerWords: clientBool("speechRemoveFillerWords", true),
        speechSilenceFiltering: clientBool("speechSilenceFiltering", true),
      });
      if (!cancelled) transcript.set(text.trim());
    } catch (cause) {
      session = null;
      if (!cancelled) failure.set(microphoneError((cause as { code?: string } | null)?.code ?? null) ?? (cause instanceof Error ? cause.message : "Voice transcription failed. Check the destination in Settings → Voice."));
    } finally {
      if (!cancelled) phase.set("idle");
    }
  };
  const close = () => { cancelled = true; void session?.stop(); phase.set("idle"); open.set(false); transcript.set(null); failure.set(null); };
  return (
    <View class="max-w-full items-end gap-2" testID="Model test">
      {!available() ? (
        <Text class="text-xs text-muted-foreground" testID="Test model unavailable">{props.status?.supported === false ? props.status.reason : voiceConnected() ? MICROPHONE_UNAVAILABLE : "Waiting for the environment to connect"}</Text>
      ) : phase() === "idle" ? (
        <PillButton label="Test model" onPress={() => void start()}><VoiceIcon name="mic" size={14} /><Text class="text-sm text-foreground">Test model</Text></PillButton>
      ) : (
        <View class="h-7 flex-row items-center gap-2">
          {phase() === "recording" ? <Text accessibilityLabel="Recording time" class="text-xs text-muted-foreground">{`${Math.floor(elapsed() / 60)}:${String(elapsed() % 60).padStart(2, "0")}`}</Text>
            : <Text class="text-xs text-muted-foreground">{phase() === "transcribing" ? "Transcribing…" : "Opening microphone…"}</Text>}
          {phase() === "recording" ? <PillButton label="Stop recording" onPress={() => void session?.stop()}><VoiceIcon name="check" size={14} /></PillButton> : null}
        </View>
      )}
      {open() ? (
        <View class="w-96 max-w-full gap-2">
          <View class="flex-row items-start gap-2">
            <Text class="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">Say a sentence in the language above. Cleanup is skipped, so you see exactly what the model heard. The transcript stays on this page.</Text>
            <View role="button" accessibilityLabel="Close model test" onPress={close} class="size-7 items-center justify-center rounded-md hover:bg-accent"><VoiceIcon name="x" size={14} /></View>
          </View>
          {failure() ? <Text role="alert" class="text-sm text-destructive-foreground">{failure()}</Text>
            : transcript() !== null ? <View selectable><Text accessibilityLabel="Test transcript" class="text-sm leading-relaxed text-foreground">{transcript() || "No speech recognized. Try again."}</Text></View> : null}
        </View>
      ) : null}
    </View>
  );
}

function AdvancedSpeechSettings(props: { status: Extract<EnvironmentSpeechStatus, { supported: true }>; catalog: ReturnType<typeof createVoiceCatalog> }) {
  const { catalog } = props;
  return (
    <AdvancedFold forceOpen={() => settingsTarget()?.path === VOICE_PATH && ["speech-hardware"].includes(settingsTarget()?.id ?? "")}>
      <VoiceRow id="speech-hardware" title="Hardware" description="Auto uses the environment’s GPU when it has one." control={
        <VoiceSelect
          label="Transcription hardware" value={props.status.acceleration} disabled={catalog.controlsDisabled()} triggerText={accelerationLabel(props.status)}
          items={[{ value: "auto", title: "Auto" }, { value: "cpu", title: "CPU" }, ...props.status.gpuDevices.map((device) => ({ value: `gpu:${device.id}`, title: device.name }))]}
          onChange={(value) => void catalog.run("Could not change transcription hardware", () => updateSpeechAcceleration(value))}
        />
      } />
      <VoiceRow id={null} title="Unload model" description="Release the model’s memory on the environment after it sits idle." control={
        <VoiceSelect
          label="Unload model" value={props.status.modelUnloadTimeout} disabled={catalog.controlsDisabled()}
          items={(Object.keys(UNLOAD_LABELS) as SpeechModelUnloadTimeout[]).map((timeout) => ({ value: timeout, title: UNLOAD_LABELS[timeout] }))}
          onChange={(value) => void catalog.run("Could not change when the model unloads", () => updateSpeechModelUnloadTimeout(value as SpeechModelUnloadTimeout))}
        />
      } />
    </AdvancedFold>
  );
}

export function VoiceSettings() {
  const environments = () => connectedEnvironments();
  const destination = (): VoiceTranscriptionDestination | null => audioGrant()?.destination ?? null;
  const cloudProvider = (): CloudSpeechProvider | null => { const d = destination(); return d && d.kind === "cloud" ? d.provider : null; };
  const chosenEnvironment = () => environments().find((environment) => environment.environmentId === destination()?.environmentId);
  const chosenUnsupported = () => { const d = destination(); const env = chosenEnvironment(); return d !== null && d.kind === "environment" && env !== undefined && !env.voiceTranscription; };
  // The environment transcribes locally: it is connected, advertises voiceTranscription and is not a cloud choice.
  const preparedOn = () => { const d = destination(); const env = chosenEnvironment(); return d !== null && d.kind === "environment" && env !== undefined && env.voiceTranscription && voiceConnected(); };
  const catalog = createVoiceCatalog(preparedOn);
  const model = () => { const status = catalog.status(); return preparedOn() && status?.supported ? status : null; };
  const pendingCloud = signal<{ provider: CloudSpeechProvider; environmentId: string } | null>(null);
  const preferred = preferredLanguages();

  const options = computed(() => destinationOptions(environments()));
  const selectItems = () => [
    { value: OFF, title: "Off", icon: "mic-off" as const },
    ...options().map((option) => ({ value: option.value, title: option.label, group: option.group, icon: option.kind === "environment" ? ("monitor" as const) : undefined })),
    ...(destination() && (!chosenEnvironment() || (cloudProvider() && !options().some((option) => option.value === destinationValue(destination())))) ? [{ value: destinationValue(destination()), title: "Chosen environment (unavailable)" }] : []),
  ];
  const label = () => destinationLabel(destination(), environments());
  const pickDestination = (value: string) => {
    const cloud = options().find((option) => option.value === value && option.kind === "cloud");
    if (cloud?.provider) { pendingCloud.set({ provider: cloud.provider, environmentId: cloud.environmentId }); return; }
    pendingCloud.set(null);
    const chosen = options().find((option) => option.value === value);
    if (value === OFF) chooseAudioDestination(null);
    else if (chosen) chooseAudioDestination({ kind: "environment", environmentId: chosen.environmentId });
  };
  const pendingEnvironment = () => environments().find((environment) => environment.environmentId === pendingCloud()?.environmentId);
  const manageLabel = () => (cloudProvider() === "openrouter" ? "Manage OpenRouter" : "Manage key");

  const microphone = voiceMicrophone;
  // refreshMicrophones: listed when the page opens and on "Refresh microphones" (no devicechange event here).
  const microphones = signal<Microphone[]>([]);
  const refreshMicrophones = () => void listMicrophones().then((list) => microphones.set(list), () => microphones.set([]));
  queueMicrotask(refreshMicrophones);
  const microphoneLabel = () => (microphone() ? microphones().find((device) => device.deviceId === microphone())?.label ?? "Selected microphone (unavailable)" : "System default");
  const microphoneItems = () => [
    { value: SYSTEM_DEFAULT, title: "System default" },
    ...microphones().map((device) => ({ value: `device:${device.deviceId}`, title: device.label })),
    ...(microphone() && !microphones().some((device) => device.deviceId === microphone()) ? [{ value: `device:${microphone()}`, title: "Selected microphone (unavailable)" }] : []),
  ];
  const shortcut = () => { const value = readSetting("voiceShortcutMode", "client"); return (typeof value === "string" && value in SHORTCUT_MODE_LABELS ? value : "auto") as VoiceShortcutMode; };
  const language = computed(() => languageSelectView(cloudProvider() ? cloudSpeechLanguages : model(), speechLanguage()));

  const prompt = () => postProcessingPrompt();

  return (
    <>
      <VoiceInputSetup />
      <SettingsSection title="Input">
        <VoiceRow first id="voice-microphone" title="Microphone"
          description="System default follows your operating system. Record a ten-second test and play it back here. Test audio stays on this device and is never transcribed."
          control={
            <View class="min-w-0 flex-row flex-wrap items-center justify-end gap-1.5">
              <MicrophoneTest />
              <View class="min-w-0 flex-row items-center gap-1.5">
                <VoiceSelect
                  label="Microphone" value={microphone() ? `device:${microphone()}` : SYSTEM_DEFAULT} items={microphoneItems()} triggerText={microphoneLabel()} maxWidth={256}
                  onChange={(value) => setClient("voiceMicrophone", value === SYSTEM_DEFAULT ? "" : value.slice("device:".length))}
                />
                <VoiceIconButton label="Refresh microphones" icon="refresh-cw" onPress={refreshMicrophones} />
              </View>
            </View>
          } />
        <VoiceRow id="dictation-shortcut-mode" title="Dictation shortcut" description="How the dictation shortcut starts and stops recording." control={
          <VoiceSelect
            label="Dictation shortcut mode" value={shortcut()} maxWidth={288}
            items={(Object.keys(SHORTCUT_MODE_LABELS) as VoiceShortcutMode[]).map((mode) => ({ value: mode, title: SHORTCUT_MODE_LABELS[mode] }))}
            onChange={(value) => setClient("voiceShortcutMode", value)}
          />
        } />
      </SettingsSection>

      <SettingsSection title="Transcription">
        <View class="px-4 py-3" testID="Transcribe with" ref={(node: any) => registerSettingsRow(VOICE_PATH, "voice-transcription-destination", node)}>
          <View class="flex-row items-center justify-between gap-2">
            <Text class="shrink-0 text-sm font-medium text-foreground">Transcribe with</Text>
            <View class="min-w-0 flex-row items-center justify-end gap-1">
              <VoiceSelect
                label="Transcribe with" value={destinationValue(destination())} items={selectItems()} maxWidth={288}
                triggerText={label().text} triggerSuffix={label().via ? ` via ${label().via}` : null}
                triggerIcon={label().icon === "off" ? "mic-off" : label().icon === "environment" ? "monitor" : null}
                onChange={pickDestination}
              />
              {cloudProvider() && chosenEnvironment() ? (
                <VoiceIconButton label={manageLabel()} icon="key-round" tooltip={manageLabel()} onPress={() => { const provider = cloudProvider(); const env = chosenEnvironment(); if (provider && env) pendingCloud.set({ provider, environmentId: env.environmentId }); }} />
              ) : null}
            </View>
          </View>
          {destination() && chosenUnsupported() ? (
            <Text class="mt-2 text-xs text-destructive-foreground">{`${chosenEnvironment()?.label ?? ""} can’t transcribe audio locally. Choose a different destination.`}</Text>
          ) : null}
        </View>

        {pendingCloud() && pendingEnvironment() ? (
          <CloudVoiceDialog
            environment={pendingEnvironment()!} provider={pendingCloud()!.provider}
            active={destination()?.environmentId === pendingCloud()!.environmentId && cloudProvider() === pendingCloud()!.provider}
            close={() => pendingCloud.set(null)}
          />
        ) : null}

        {model() || cloudProvider() ? (
          <VoiceRow id="speech-language" title="Language"
            description={cloudProvider() ? "The cloud provider can detect your language automatically."
              : model() ? `${model()!.model} ${model()!.supportsLanguageDetection ? "detects the language automatically" : "uses one fixed language"}.`
              : "Choose an environment above to see the languages its transcription model supports."}
            control={
              <VoiceSelect
                label="Transcription language" value={speechLanguage()} disabled={language().disabled} triggerText={language().label} maxWidth={256}
                items={[
                  { value: "auto", title: "Auto" },
                  ...(language().unavailable ? [{ value: speechLanguage(), title: language().unavailable!, disabled: true }] : []),
                  ...language().codes.map((code) => ({ value: code, title: languageLabel(code) })),
                ]}
                onChange={setSpeechLanguage}
              />
            } />
        ) : null}
        {model()?.supportsTranslation ? (
          <VoiceRow id={null} title="Translate to English" description="Speak any language and get English text." control={<ClientSwitch label="Translate to English" field="speechTranslateToEnglish" fallback={false} />} />
        ) : null}

        {catalog.status()?.supported === false && preparedOn() ? (
          <View><View class="h-px bg-border-50" /><Text class="px-4 py-2 text-sm text-muted-foreground">{`This environment can’t transcribe audio: ${(catalog.status() as { reason: string }).reason}.`}</Text></View>
        ) : null}
        {preparedOn() && model() ? (
          <ModelBrowser status={model()!} catalog={catalog} preferred={preferred} testControls={() => <TranscriptionTest status={catalog.status()} />} />
        ) : null}
        {preparedOn() && model() ? <AdvancedSpeechSettings status={model()!} catalog={catalog} /> : null}
      </SettingsSection>

      <SettingsSection title="Transcription options">
        <VoiceRow first id="speech-silence-filtering" title="Silence filtering"
          description={cloudProvider() === "openai" ? "OpenAI handles silence automatically." : "Skip silence and other non-speech audio before transcription, keeping a short buffer so words aren’t cut off."}
          control={<ClientSwitch label="Silence filtering" field="speechSilenceFiltering" fallback disabled={cloudProvider() === "openai"} />} />
        <VoiceRow id="remove-filler-words" title="Remove filler words" description="Remove filler words like “um” and “uh” from transcripts." control={<ClientSwitch label="Remove filler words" field="speechRemoveFillerWords" fallback />} />
        <VoiceRow id="speech-dictionary" title="Dictionary"
          description="Names and terms transcription should spell your way, saved on this device. Add an alias when it keeps hearing a term wrong. The name of the project you dictate in is also sent as a hint."
          control={<Text class="text-xs text-muted-foreground">{entryCountLabel(speechCustomWords().length)}</Text>}>
          <View class="mt-2 pb-3.5"><DictionaryEditor label="dictionary" words={speechCustomWords} onChange={setSpeechCustomWords} /></View>
        </VoiceRow>
        <VoiceRow id="speech-project-dictionary" title="Shared dictionary"
          description="Saved on the environment and used in every project there, along with each person’s own dictionary. Pick a project above to limit these words to one project."
          control={<Text class="text-xs text-muted-foreground">{entryCountLabel(projectCustomWords().length)}</Text>}>
          <View class="mt-2 pb-3.5"><DictionaryEditor label="shared dictionary" words={projectCustomWords} disabled={environments().length === 0} onChange={setProjectCustomWords} /></View>
        </VoiceRow>
      </SettingsSection>

      <SettingsSection title="Cleanup">
        <VoiceRow first id={null} title="Clean up transcripts"
          description="Fixes punctuation, numbers, and spoken corrections with the cleanup model on the draft’s environment. Sends the transcript and nearby draft text, never audio."
          control={<SettingsSwitch label="Clean up transcripts" checked={cleanupEnabled()} onChange={chooseTranscriptCleanup} />} />
        {cleanupEnabled() ? (
          <VoiceRow id={null} title="Cleanup instructions" description="Use the built-in instructions or write your own."
            control={
              <VoiceSelect
                label="Cleanup instructions" value={prompt().mode} maxWidth={256}
                items={[{ value: "default", title: "Built-in" }, { value: "custom", title: "Custom" }]}
                onChange={(value) => { if (value === "default" || value === "custom") setPostProcessingPrompt({ ...prompt(), mode: value }); }}
              />
            }>
            <View class="mt-2 pb-3.5">
              <DraftInputArea />
            </View>
          </VoiceRow>
        ) : null}
        {cleanupEnabled() ? (
          <VoiceRow id="speech-post-processing-model" title="Cleanup model"
            description="Model for transcript cleanup, such as a cheaper or faster one. When disabled, use the text generation model configured for this environment."
            control={environments().length === 0
              ? <Text class="text-sm text-muted-foreground">Connect an environment first.</Text>
              : <ModelSelectionControl field="speechPostProcessingModelSelection" label="Cleanup model" switchLabel="Use a separate cleanup model" dedicated />} />
        ) : null}
        {cleanupEnabled() ? (
          <VoiceRow id="speech-correction-word" title="Correction cue"
            description="The word or phrase you say to flag a correction, like “sorry” or “scratch that”. Cleanup applies the correction only where one is meant, and hears the cue as a hint."
            control={<DraftInput label="Correction cue" value={correctionCue()} placeholder="sorry" class="w-40" onCommit={(next) => { const trimmed = next.trim().slice(0, 50); if (trimmed !== correctionCue()) setClient("speechCorrectionWord", trimmed); }} />} />
        ) : null}
      </SettingsSection>
    </>
  );
}

/** The textarea under "Cleanup instructions": the built-in prompt read-only, or the person's own. */
function DraftInputArea() {
  const prompt = () => postProcessingPrompt();
  return (
    <TextArea
      label="Custom cleanup instructions" readonly={prompt().mode !== "custom"}
      value={prompt().mode === "custom" ? prompt().customInstructions : DEFAULT_SPEECH_POST_PROCESSING_PROMPT}
      onChange={(value) => setPostProcessingPrompt({ mode: "custom", customInstructions: value.slice(0, 10_000) })}
    />
  );
}
