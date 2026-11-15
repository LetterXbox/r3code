// The voice input setup flow (speech/useEnvironmentSpeechInput.ts: start, loadSetupCatalog, downloadSetupModel,
// cancelSetupDownload; shared/speech.ts chooseSetupSpeechModel). Every dictation entry point goes through
// `startVoiceInput`: no granted destination sends a first run to Settings > Voice; otherwise the environment's speech
// status decides between the setup dialog (a missing model), an error toast (unsupported) and recording.
// `openVoiceInputSetup()` opens the dialog from anywhere (the Voice settings page).
import { locale, signal, untracked } from "nsh";
import {
  cancelSpeechModelDownload, downloadSpeechModel, getSpeechModels, getSpeechStatus, selectSpeechModel,
} from "../../pages/settings/voice/voiceApi";
import { effectiveSpeechLanguage } from "../../pages/settings/voice/speech";
import type { EnvironmentSpeechModel, EnvironmentSpeechStatus } from "../../pages/settings/voice/speech";
import { audioChoice, connectedEnvironments } from "../../pages/settings/voice/voiceState";
import { readSetting } from "../../pages/settings/settingsSync";
import { showToast } from "../toast/toastState";
import { openSettings } from "../../store";

type ModelLike = { readonly id: string; readonly languages: readonly string[]; readonly supportsLanguageDetection: boolean; readonly recommended: boolean };

/** chooseSetupSpeechModel: the model to offer for the person's language (or preferred languages), the selected one first. */
export function chooseSetupSpeechModel<Model extends ModelLike>(models: readonly Model[], input: { selectedModelId: string; intent: string; preferred: readonly string[] }): { model: Model; language: string | null } | undefined {
  if (input.intent === "auto" && input.preferred.length === 0) {
    const model = models.find(({ id }) => id === input.selectedModelId);
    return model && { model, language: null };
  }
  for (const language of input.intent === "auto" ? input.preferred : [input.intent]) {
    const capable = models.filter((model) => {
      const effective = effectiveSpeechLanguage(model, input.intent);
      return effective === language || (effective === "auto" && model.languages.includes(language));
    });
    const model = capable.find(({ id }) => id === input.selectedModelId) ?? capable.find(({ recommended }) => recommended) ?? capable[0];
    if (model) return { model, language };
  }
  return undefined;
}

export interface VoiceSetupApi {
  status(): Promise<EnvironmentSpeechStatus>;
  models(): Promise<readonly EnvironmentSpeechModel[]>;
  download(modelId: string): Promise<readonly EnvironmentSpeechModel[]>;
  select(modelId: string): Promise<unknown>;
  cancel(modelId: string): Promise<unknown>;
}

export interface SetupState {
  open: boolean;
  /** 0 is "Model", 1 is "Ready to dictate". */
  step: 0 | 1;
  model: EnvironmentSpeechModel | null;
  language: string | null;
  downloading: boolean;
  error: string | null;
  catalogFailed: boolean;
  status: EnvironmentSpeechStatus | null;
}
export const INITIAL_SETUP: SetupState = { open: false, step: 0, model: null, language: null, downloading: false, error: null, catalogFailed: false, status: null };

export interface VoiceSetupEnv { language: () => string; preferred: () => readonly string[]; pollMs?: number }

export interface VoiceSetup {
  state: () => SetupState;
  /** Opens the dialog and loads the catalog, offering the model for the language (loadSetupCatalog). */
  begin(status: Extract<EnvironmentSpeechStatus, { supported: true }>, startRecording: () => void): Promise<void>;
  download(): Promise<void>;
  cancelDownload(): Promise<void>;
  retryCatalog(): Promise<void>;
  setOpen(open: boolean): void;
  /** "Start dictating": closes the dialog and records. */
  startRecording(): void;
}

export function createVoiceSetup(api: VoiceSetupApi, env: VoiceSetupEnv): VoiceSetup {
  const state = signal<SetupState>(INITIAL_SETUP);
  let request = 0;
  let record: () => void = () => {};
  let poll: ReturnType<typeof setInterval> | null = null;
  const patch = (next: Partial<SetupState>) => state.update((current) => ({ ...current, ...next }));
  const stopPoll = () => { if (poll !== null) { clearInterval(poll); poll = null; } };
  const startPoll = (modelId: string) => {
    stopPoll();
    let refreshing = false;
    poll = setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      api.models().then((models) => {
        const model = models.find((candidate) => candidate.id === modelId);
        if (model && untracked(() => state()).downloading) patch({ model });
      }).catch(() => undefined).finally(() => { refreshing = false; });
    }, env.pollMs ?? 1000);
  };

  const load = async (status: Extract<EnvironmentSpeechStatus, { supported: true }>, mine: number) => {
    state.set({ ...INITIAL_SETUP, open: true, status });
    let models: readonly EnvironmentSpeechModel[] | null;
    try { models = await api.models(); } catch { models = null; }
    if (mine !== request) return;
    const choice = chooseSetupSpeechModel(models ?? [], { selectedModelId: status.modelId, intent: env.language(), preferred: env.preferred() });
    patch({
      model: choice?.model ?? null, language: choice?.language ?? null, catalogFailed: models === null,
      error: choice ? null : models ? "No model matches your language. Choose a model or change the language in Voice settings." : "Could not load transcription models. Check the connection and try again.",
    });
  };

  return {
    state: () => state(),
    async begin(status, startRecording) { record = startRecording; request += 1; await load(status, request); },
    async retryCatalog() { const status = state().status; if (status?.supported) { request += 1; await load(status, request); } },
    setOpen(open) { if (!open) { request += 1; stopPoll(); patch({ open: false }); } else patch({ open }); },
    startRecording() { stopPoll(); patch({ open: false }); record(); },
    async download() {
      const current = state();
      const status = current.status;
      if (!status?.supported || !current.model || current.downloading) return;
      const modelId = current.model.id;
      const mine = ++request;
      patch({ downloading: true, error: null });
      startPoll(modelId);
      try {
        const models = await api.download(modelId);
        if (mine !== request) return;
        // A download cancelled from elsewhere still resolves, so the model is selected only once it landed.
        const installed = models.some(({ id, state: modelState }) => id === modelId && modelState === "installed");
        if (installed && modelId !== status.modelId) {
          try { await api.select(modelId); } catch {
            if (mine !== request) return;
            stopPoll();
            patch({ downloading: false, error: "The model downloaded, but this environment could not select it. Try again." });
            return;
          }
        }
        if (mine !== request) return;
        const next = await api.status();
        if (mine !== request) return;
        stopPoll();
        const ready = installed && next.supported && next.modelId === modelId && next.state !== "missing-model";
        patch({ status: next, downloading: false, step: ready ? 1 : state().step, error: ready ? null : "The model is not ready. Try downloading it again." });
      } catch {
        if (mine !== request) return;
        stopPoll();
        patch({ downloading: false, error: "Could not download the model. Check this environment's connection and try again." });
      }
    },
    async cancelDownload() {
      const modelId = state().model?.id;
      if (!modelId) return;
      request += 1;
      stopPoll();
      patch({ open: false, downloading: false });
      try { await api.cancel(modelId); } catch (cause) { patch({ error: cause instanceof Error ? cause.message : String(cause) }); }
    },
  };
}

// ---- Starting dictation ----

export interface StartDeps {
  /** `voiceAudioChoice`: a granted destination, off, or never chosen. */
  choice: () => "granted" | "off" | "unset";
  destination: () => "environment" | "cloud";
  api: Pick<VoiceSetupApi, "status">;
  setup: Pick<VoiceSetup, "begin">;
  openVoiceSettings: () => void;
  toast: (input: { type: "error"; title: string; description?: string }) => void;
  /** Begins listening. */
  record: () => Promise<void> | void;
}

export type StartOutcome = "settings" | "off" | "recording" | "setup" | "unavailable" | "failed";

/** start() of useEnvironmentSpeechInput. */
export async function startVoiceInput(deps: StartDeps): Promise<StartOutcome> {
  const choice = deps.choice();
  if (choice === "unset") { deps.openVoiceSettings(); return "settings"; }
  if (choice === "off") return "off";
  if (deps.destination() === "cloud") { await deps.record(); return "recording"; }
  let status: EnvironmentSpeechStatus;
  try { status = await deps.api.status(); } catch (cause) {
    deps.toast({ type: "error", title: "Could not start voice input", description: cause instanceof Error ? cause.message : String(cause) });
    return "failed";
  }
  if (status.supported && status.state === "missing-model") {
    await deps.setup.begin(status, () => void startVoiceInput(deps));
    return "setup";
  }
  if (!status.supported) { deps.toast({ type: "error", title: "Voice input is not available", description: status.reason }); return "unavailable"; }
  await deps.record();
  return "recording";
}

// ---- The app's one setup flow, on the environment's real voice API ----

const realApi: VoiceSetupApi = { status: getSpeechStatus, models: () => getSpeechModels(false), download: downloadSpeechModel, select: selectSpeechModel, cancel: cancelSpeechModelDownload };
const languageSetting = () => { const value = readSetting("speechLanguage", "client"); return typeof value === "string" && value ? value : "auto"; };
/** The system language as the preferred list (navigator.languages' stand-in). */
export const preferredSpeechLanguages = (): readonly string[] => { const tag = locale().split("-")[0]; return tag ? [tag] : []; };

export const voiceSetup: VoiceSetup = createVoiceSetup(realApi, { language: languageSetting, preferred: preferredSpeechLanguages });
export const setupEnvironmentLabel = () => connectedEnvironments()[0]?.label ?? "your transcription environment";

export const grantedDestination = (): "environment" | "cloud" => { const choice = audioChoice(); return choice && choice !== "off" && choice.destination.kind === "cloud" ? "cloud" : "environment"; };
export const voiceChoice = (): "granted" | "off" | "unset" => { const choice = audioChoice(); return choice === null ? "unset" : choice === "off" ? "off" : "granted"; };

/** The Voice settings page's entry: probes the environment and opens the setup dialog when its model is missing. */
export async function openVoiceInputSetup(startRecording: () => void = () => {}): Promise<void> {
  try {
    const status = await realApi.status();
    if (status.supported) await voiceSetup.begin(status, startRecording);
    else showToast({ type: "error", title: "Voice input is not available", description: status.reason });
  } catch (cause) {
    showToast({ type: "error", title: "Could not start voice input", description: cause instanceof Error ? cause.message : String(cause) });
  }
}

/** Composer's mic button and dictation shortcut: `record` begins listening once the flow allows it. */
export function startRealVoiceInput(record: () => Promise<void> | void): Promise<StartOutcome> {
  return startVoiceInput({
    choice: voiceChoice, destination: grantedDestination, api: realApi, setup: voiceSetup,
    openVoiceSettings: () => openSettings("/settings/voice"), toast: (input) => { showToast(input); }, record,
  });
}
