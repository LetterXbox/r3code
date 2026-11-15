// The environment's transcription model catalog and engine status, as the web's useVoiceModels hook keeps
// them (VoiceSettingsPanel.tsx): a foreground load with benchmarks, progress polls while a download runs
// (keeping the benchmarks the foreground load fetched), and `run`, which makes one action and then reloads.
// The reference gates the actions on the settings-write scope; this client has no scope list to read, so a
// connected environment is managed by this session.
import { computed, effect, signal, untracked } from "nsh";
import { showToast } from "../../../components/toast/toastState";
import {
  cancelSpeechModelDownload, downloadSpeechModel, getSpeechModels, getSpeechStatus, removeSpeechModel, selectSpeechModel, voiceConnected,
} from "./voiceApi";
import type { EnvironmentSpeechModel, EnvironmentSpeechStatus } from "./speech";

let pollMs = 1000;
/** Tests shorten the progress poll; the app never calls this. */
export function configureVoiceCatalog(options: { pollMs?: number }) {
  if (options.pollMs !== undefined) pollMs = options.pollMs;
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export interface VoiceCatalog {
  models: () => readonly EnvironmentSpeechModel[];
  status: () => EnvironmentSpeechStatus | null;
  /** The last failed load or action, for a state the toast has already left. */
  error: () => string;
  controlsDisabled: () => boolean;
  canCancel: () => boolean;
  requestedDownload: () => string | null;
  run: (label: string, work: () => Promise<unknown>, downloadId?: string) => Promise<void>;
  select: (id: string) => Promise<void>;
  download: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  refresh: (mode: "foreground" | "progress") => Promise<void>;
}

/** Create inside a component: it loads while `enabled` (the environment is the transcriber and connected) and polls while a download is in flight. */
export function createVoiceCatalog(enabled: () => boolean = voiceConnected): VoiceCatalog {
  const models = signal<readonly EnvironmentSpeechModel[]>([]);
  const status = signal<EnvironmentSpeechStatus | null>(null);
  const busy = signal(false);
  const requestedDownload = signal<string | null>(null);
  const error = signal("");
  let epoch = 0;
  let revision = 0;

  const refresh = async (mode: "foreground" | "progress") => {
    const current = epoch;
    const mine = ++revision;
    try {
      const [nextStatus, nextModels] = await Promise.all([getSpeechStatus(), getSpeechModels(mode === "foreground")]);
      if (current !== epoch || mine !== revision) return;
      status.set(nextStatus);
      if (mode === "foreground") models.set(nextModels);
      else {
        const benchmarks = new Map(untracked(() => models()).map((model) => [model.id, model.benchmark]));
        models.set(nextModels.map((model) => { const benchmark = benchmarks.get(model.id); return benchmark ? { ...model, benchmark } : model; }));
      }
      error.set("");
    } catch (cause) {
      if (mode === "progress") return;
      if (current !== epoch || mine !== revision) return;
      error.set(message(cause));
      showToast({ type: "error", title: "Could not load transcription models", description: message(cause) });
    }
  };

  // The catalog belongs to the connection: a new connection starts from nothing and loads again.
  effect(() => {
    const connected = enabled();
    untracked(() => {
      epoch += 1;
      busy.set(false);
      requestedDownload.set(null);
      models.set([]);
      status.set(null);
      error.set("");
      if (connected) void refresh("foreground");
    });
    return () => { epoch += 1; };
  });

  // A computed, so the poll effect re-runs when downloading starts or stops, not on every reload of the models.
  const downloading = computed(() => requestedDownload() !== null || models().some((model) => model.state === "downloading" || model.state === "verifying"));
  effect(() => {
    if (!enabled() || !downloading()) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh("progress");
      if (!cancelled) timer = setTimeout(() => void poll(), pollMs);
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  });

  const run = async (label: string, work: () => Promise<unknown>, downloadId?: string) => {
    if (!voiceConnected()) return;
    const current = epoch;
    if (downloadId) requestedDownload.set(downloadId);
    else busy.set(true);
    try {
      await work();
    } catch (cause) {
      if (current === epoch) {
        error.set(message(cause));
        showToast({ type: "error", title: label, description: message(cause) });
      }
    }
    if (current === epoch) {
      if (downloadId) requestedDownload.set(null);
      else busy.set(false);
      await refresh("foreground");
    }
  };

  return {
    models, status, error, requestedDownload, refresh, run,
    controlsDisabled: () => busy() || downloading() || !voiceConnected(),
    canCancel: () => voiceConnected() && !busy(),
    download: (id) => run("Could not download the model", () => downloadSpeechModel(id), id),
    select: (id) => run("Could not select the model", () => selectSpeechModel(id)),
    cancel: (id) => run("Could not cancel the download", () => cancelSpeechModelDownload(id)),
    remove: (id) => run("Could not delete the model", () => removeSpeechModel(id)),
  };
}
