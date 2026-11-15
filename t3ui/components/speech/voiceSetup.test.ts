import { expect, test } from "nsh/test";
import { chooseSetupSpeechModel, createVoiceSetup, startVoiceInput } from "./voiceSetup";
import type { StartDeps, VoiceSetupApi } from "./voiceSetup";
import type { EnvironmentSpeechStatus } from "../../pages/settings/voice/speech";
import { parseSpeechModels, parseSpeechStatus } from "../../pages/settings/voice/speech";

// Contract-shaped payloads (EnvironmentSpeechStatus, EnvironmentSpeechModel).
const readyStatus = parseSpeechStatus({ supported: true, state: "ready", modelId: "parakeet", model: "Parakeet", size: 730_000_000, supportsStreaming: true, supportsTranslation: false, acceleration: "auto", benchmarkTier: "cpu", modelUnloadTimeout: "never", gpuDevices: [] }) as Extract<EnvironmentSpeechStatus, { supported: true }>;
const missing = { ...readyStatus, state: "missing-model" as const };
const modelsPayload = (state: string, downloaded?: number) => parseSpeechModels({ models: [
  { id: "parakeet", name: "Parakeet Unified English 0.6B", description: "d", size: 730_000_000, languages: ["en"], accuracy: 4, speed: 4, recommended: true, supportsStreaming: true, supportsLanguageDetection: false, supportsTranslation: false, active: false, state, ...(downloaded === undefined ? {} : { downloaded }) },
  { id: "whisper", name: "Whisper", description: "d", size: 1_500_000_000, languages: ["en", "de", "fr"], accuracy: 5, speed: 2, recommended: false, supportsStreaming: false, supportsLanguageDetection: true, supportsTranslation: true, active: false, state: "downloadable" },
] });

function api(overrides: Partial<VoiceSetupApi> = {}) {
  const calls: string[] = [];
  const value: VoiceSetupApi = {
    status: async () => { calls.push("status"); return readyStatus; },
    models: async () => modelsPayload("downloadable"),
    download: async (id) => { calls.push(`download:${id}`); return modelsPayload("installed"); },
    select: async (id) => { calls.push(`select:${id}`); },
    cancel: async (id) => { calls.push(`cancel:${id}`); },
    ...overrides,
  };
  return { value, calls };
}

function startHarness(choice: StartDeps["choice"] extends () => infer R ? R : never, status: () => Promise<unknown>, destination: "environment" | "cloud" = "environment") {
  const log: string[] = [];
  const deps: StartDeps = {
    choice: () => choice, destination: () => destination, api: { status: status as never },
    setup: { begin: async (given) => { log.push(`setup:${given.modelId}`); } },
    openVoiceSettings: () => log.push("settings"), toast: (input) => log.push(`toast:${input.title}|${input.description ?? ""}`), record: () => { log.push("record"); },
  };
  return { deps, log };
}

test("no choice yet sends a first run to Voice settings, and off does nothing", async () => {
  const unset = startHarness("unset", async () => readyStatus);
  expect(await startVoiceInput(unset.deps)).toBe("settings");
  expect(unset.log).toEqual(["settings"]);
  const off = startHarness("off", async () => readyStatus);
  expect(await startVoiceInput(off.deps)).toBe("off");
  expect(off.log).toEqual([]);
});

test("a missing model opens the setup dialog, an unsupported environment toasts its reason, a ready one records", async () => {
  const missingModel = startHarness("granted", async () => missing);
  expect(await startVoiceInput(missingModel.deps)).toBe("setup");
  expect(missingModel.log).toEqual(["setup:parakeet"]);
  const unsupported = startHarness("granted", async () => parseSpeechStatus({ supported: false, reason: "No speech engine on this machine" }));
  expect(await startVoiceInput(unsupported.deps)).toBe("unavailable");
  expect(unsupported.log).toEqual(["toast:Voice input is not available|No speech engine on this machine"]);
  const ready = startHarness("granted", async () => readyStatus);
  expect(await startVoiceInput(ready.deps)).toBe("recording");
  expect(ready.log).toEqual(["record"]);
  const failed = startHarness("granted", async () => { throw new Error("offline"); });
  expect(await startVoiceInput(failed.deps)).toBe("failed");
  expect(failed.log).toEqual(["toast:Could not start voice input|offline"]);
  const cloud = startHarness("granted", async () => { throw new Error("never asked"); }, "cloud");
  expect(await startVoiceInput(cloud.deps)).toBe("recording");
});

test("the model offered follows the saved language, then the preferred ones, the selected model first", () => {
  const models = modelsPayload("downloadable");
  expect(chooseSetupSpeechModel(models, { selectedModelId: "whisper", intent: "auto", preferred: [] })?.model.id).toBe("whisper");
  expect(chooseSetupSpeechModel(models, { selectedModelId: "whisper", intent: "auto", preferred: ["en"] })).toMatchObject({ model: { id: "whisper" }, language: "en" });
  expect(chooseSetupSpeechModel(models, { selectedModelId: "none", intent: "auto", preferred: ["en"] })).toMatchObject({ model: { id: "parakeet" }, language: "en" });
  expect(chooseSetupSpeechModel(models, { selectedModelId: "none", intent: "ja", preferred: [] })).toBeUndefined();
});

test("begin loads the catalog and offers the recommended model; a language no model speaks, or a failed load, say so", async () => {
  const good = createVoiceSetup(api().value, { language: () => "auto", preferred: () => ["en"] });
  await good.begin(missing, () => {});
  expect(good.state()).toMatchObject({ open: true, step: 0, language: "en", error: null, catalogFailed: false });
  expect(good.state().model?.name).toBe("Parakeet Unified English 0.6B");
  const noMatch = createVoiceSetup(api().value, { language: () => "ja", preferred: () => [] });
  await noMatch.begin(missing, () => {});
  expect(noMatch.state().error).toBe("No model matches your language. Choose a model or change the language in Voice settings.");
  const failed = createVoiceSetup(api({ models: async () => { throw new Error("x"); } }).value, { language: () => "auto", preferred: () => ["en"] });
  await failed.begin(missing, () => {});
  expect(failed.state()).toMatchObject({ catalogFailed: true, error: "Could not load transcription models. Check the connection and try again." });
});

test("downloading selects the model when it differs, polls progress, and goes to Ready to dictate; start closes and records", async () => {
  const fake = api({
    status: async () => ({ ...readyStatus, modelId: "parakeet", state: "ready" as const }),
    download: async (id) => { fake.calls.push(`download:${id}`); await new Promise((resolve) => setTimeout(resolve, 30)); return modelsPayload("installed"); },
    models: async () => modelsPayload("downloading", 365_000_000),
  });
  const setup = createVoiceSetup(fake.value, { language: () => "auto", preferred: () => ["en"], pollMs: 5 });
  let recorded = 0;
  await setup.begin({ ...missing, modelId: "other" }, () => { recorded += 1; });
  const download = setup.download();
  expect(setup.state().downloading).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(setup.state().model?.downloaded).toBe(365_000_000);
  await download;
  expect(fake.calls.includes("download:parakeet") && fake.calls.includes("select:parakeet")).toBe(true);
  expect(setup.state()).toMatchObject({ downloading: false, step: 1, error: null });
  setup.startRecording();
  expect(recorded).toBe(1);
  expect(setup.state().open).toBe(false);
});

test("a failed download, an unselectable model and a model that is not ready each keep step one with their message", async () => {
  const failing = createVoiceSetup(api({ download: async () => { throw new Error("net"); } }).value, { language: () => "auto", preferred: () => ["en"] });
  await failing.begin(missing, () => {});
  await failing.download();
  expect(failing.state()).toMatchObject({ step: 0, downloading: false, error: "Could not download the model. Check this environment's connection and try again." });
  const unselectable = createVoiceSetup(api({ select: async () => { throw new Error("no"); } }).value, { language: () => "auto", preferred: () => ["en"] });
  await unselectable.begin({ ...missing, modelId: "other" }, () => {});
  await unselectable.download();
  expect(unselectable.state().error).toBe("The model downloaded, but this environment could not select it. Try again.");
  const notReady = createVoiceSetup(api({ status: async () => missing }).value, { language: () => "auto", preferred: () => ["en"] });
  await notReady.begin(missing, () => {});
  await notReady.download();
  expect(notReady.state()).toMatchObject({ step: 0, error: "The model is not ready. Try downloading it again." });
});

test("cancelling the download closes the dialog and cancels it on the environment", async () => {
  const fake = api({ download: () => new Promise(() => {}) });
  const setup = createVoiceSetup(fake.value, { language: () => "auto", preferred: () => ["en"] });
  await setup.begin(missing, () => {});
  void setup.download();
  await setup.cancelDownload();
  expect(fake.calls).toContain("cancel:parakeet");
  expect(setup.state()).toMatchObject({ open: false, downloading: false });
});
