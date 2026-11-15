import { expect, test } from "nsh/test";
import {
  addAlias, addTerms, benchmarkLines, browserView, cardModel, destinationLabel, destinationOptions, destinationValue, effectiveSpeechLanguage, filterSpeechModels,
  languageSelectView, modelCardView, orderSpeechLanguages, parseAudioChoice, parsePostProcessingPrompt, parseSpeechModels, parseSpeechStatus, serializeAudioChoice,
  type EnvironmentSpeechModel,
} from "./speech";

// EnvironmentSpeechModels as GET /api/voice/models sends them (packages/contracts/src/speech.ts), with both wire shapes of the benchmark.
const wire = {
  models: [
    { id: "parakeet-v3", name: "Parakeet v3", description: "Fast and accurate.", size: 480 * 1024 * 1024, languages: ["en", "de", "fr"], accuracy: 0.9, speed: 0.9, recommended: true, supportsStreaming: true, supportsLanguageDetection: true, supportsTranslation: false, active: true, state: "installed",
      benchmark: { accuracy: { en: { grade: "A", errorPercent: 4.1 }, de: { grade: "B", errorPercent: 7.5 } }, secondsPer30s: { cpu: 3.2, accelerated: 0.8 } } },
    { id: "whisper-small", name: "Whisper small", description: "Multilingual.", size: 466 * 1024 * 1024, languages: ["en", "de", "ja"], accuracy: 0.8, speed: 0.6, recommended: false, supportsStreaming: false, supportsLanguageDetection: true, supportsTranslation: true, active: false, state: "downloadable",
      benchmark: { accuracy: { en: { grade: "B", errorPercent: 6.2 } }, secondsPer30s: 2.5 } },
    { id: "whisper-tiny", name: "Whisper tiny", description: "Smallest.", size: 75 * 1024 * 1024, languages: ["en"], accuracy: 0.5, speed: 0.95, recommended: false, supportsStreaming: false, supportsLanguageDetection: false, supportsTranslation: false, active: false, state: "downloading", downloaded: 30 * 1024 * 1024 },
    { id: "whisper-base", name: "Whisper base", description: "Small.", size: 142 * 1024 * 1024, languages: ["en", "ja"], accuracy: 0.6, speed: 0.8, recommended: false, supportsStreaming: false, supportsLanguageDetection: true, supportsTranslation: false, active: false, state: "verifying", downloaded: 142 * 1024 * 1024 },
    { id: "moonshine", name: "Moonshine", description: "Local.", size: 60 * 1024 * 1024, languages: ["en"], accuracy: 0.7, speed: 0.9, recommended: false, supportsStreaming: false, supportsLanguageDetection: false, supportsTranslation: false, active: false, state: "installed" },
  ],
};
const models = parseSpeechModels(wire);
const byId = (id: string): EnvironmentSpeechModel => models.find((model) => model.id === id)!;

test("the catalog parses both benchmark wire shapes into one", () => {
  expect(models.length).toBe(5);
  expect(byId("parakeet-v3").benchmark?.secondsPer30s).toEqual({ cpu: 3.2, accelerated: 0.8 });
  // A legacy server sends one scalar and no CPU field: the CPU time is unknown, not zero.
  expect(byId("whisper-small").benchmark?.secondsPer30s).toEqual({ accelerated: 2.5 });
  expect(byId("moonshine").benchmark).toBe(undefined);
});

test("a model card is not installed, downloading with progress, verifying, installed or selected", () => {
  // not installed
  const open = modelCardView(byId("whisper-small"));
  expect([open.action, open.downloading, open.canDelete]).toEqual(["download", false, false]);
  expect(open.badges.map((badge) => badge.label)).toEqual(["Translate"]);
  // downloading with progress
  const downloading = modelCardView(byId("whisper-tiny"));
  expect([downloading.action, downloading.downloading, Math.round(downloading.progress), downloading.progressLabel]).toEqual(["cancel", true, 40, "40% downloaded"]);
  // verifying
  const verifying = modelCardView(byId("whisper-base"));
  expect([verifying.action, verifying.verifying, verifying.progressLabel]).toEqual(["cancel", true, "Verifying download…"]);
  // installed, not selected
  const installed = modelCardView(byId("moonshine"));
  expect([installed.action, installed.canDelete, installed.progressLabel]).toEqual(["use", true, null]);
  // selected
  const selected = modelCardView(byId("parakeet-v3"));
  expect([selected.action, selected.canDelete]).toEqual(["selected", true]);
  expect(selected.badges.map((badge) => badge.label)).toEqual(["Recommended", "Live preview"]);
  expect(selected.facts).toEqual(["3 languages", "480 MB"]);
});

test("a requested download shows as downloading before the environment reports it", () => {
  expect(modelCardView(cardModel(byId("whisper-small"), "whisper-small")).action).toBe("cancel");
  expect(modelCardView(cardModel(byId("whisper-small"), "other")).action).toBe("download");
  expect(modelCardView(cardModel(byId("moonshine"), "moonshine")).action).toBe("use");
});

test("an error state is a failed load: no models, and the environment's reason", () => {
  expect(parseSpeechModels(null)).toEqual([]);
  expect(parseSpeechModels({ models: [{ id: 3 }, "x"] })).toEqual([]);
  const status = parseSpeechStatus({ supported: false, reason: "no model runtime on this host" });
  expect(status).toEqual({ supported: false, reason: "no model runtime on this host" });
});

test("models sort selected, installed, downloading, then recommended, and filter by language, search and download state", () => {
  const filter = (over: Partial<Parameters<typeof filterSpeechModels>[1]> = {}) =>
    filterSpeechModels(models, { search: "", languages: [], downloadedOnly: false, sort: "recommended", accuracyLanguage: "en", benchmarkTier: "accelerated", ...over }).map((model) => model.id);
  expect(filter()).toEqual(["parakeet-v3", "moonshine", "whisper-tiny", "whisper-base", "whisper-small"]);
  expect(filter({ languages: ["en", "ja"] })).toEqual(["whisper-base", "whisper-small"]);
  expect(filter({ downloadedOnly: true })).toEqual(["parakeet-v3", "moonshine"]);
  expect(filter({ search: "smallest" })).toEqual(["whisper-tiny"]);
  expect(filter({ sort: "size" })).toEqual(["moonshine", "whisper-tiny", "whisper-base", "whisper-small", "parakeet-v3"]);
  expect(filter({ sort: "accuracy" })[0]).toBe("parakeet-v3");
  expect(filter({ sort: "speed" }).slice(0, 2)).toEqual(["parakeet-v3", "whisper-small"]);
});

test("benchmark lines name the score per language and the speed on the status's tier", () => {
  expect(benchmarkLines(byId("parakeet-v3"), ["en", "de"], "accelerated")).toEqual({
    scores: [{ language: "en", grade: "A", errorPercent: 4.1 }, { language: "de", grade: "B", errorPercent: 7.5 }], speed: "0.8 s / 30 s",
  });
  expect(benchmarkLines(byId("parakeet-v3"), [], "cpu").speed).toBe("3.2 s / 30 s");
  expect(benchmarkLines(byId("whisper-small"), [], "cpu").speed).toBe("update server");
  expect(benchmarkLines(byId("parakeet-v3"), ["ja"], "accelerated").scores).toEqual([{ language: "ja", grade: null, errorPercent: null }]);
  expect(benchmarkLines(byId("moonshine"), [], "accelerated")).toEqual({ scores: [], speed: "not benchmarked" });
});

test("the browser defaults to the person's language, keeps the selected model listed, and heads the list", () => {
  const view = browserView({ models, preferred: ["de", "en"], selection: null, languageSearch: "", search: "", sort: "recommended", downloadedOnly: false, benchmarkTier: "accelerated" });
  expect(view.selectedLanguages).toEqual(["de"]);
  expect(view.heading).toBe("Models for German");
  expect(view.rendered.map((model) => model.id)).toEqual(["parakeet-v3", "whisper-small"]);
  expect(view.visibleLanguages[0]).toBe("de");
  const hidden = browserView({ models, preferred: [], selection: ["ja"], languageSearch: "", search: "", sort: "recommended", downloadedOnly: false, benchmarkTier: "accelerated" });
  expect(hidden.activeHidden).toBe(true);
  expect(hidden.rendered[0]?.id).toBe("parakeet-v3");
  expect(hidden.rendered.length).toBe(3);
  const all = browserView({ models, preferred: [], selection: [], languageSearch: "jap", search: "zzz", sort: "size", downloadedOnly: false, benchmarkTier: "cpu" });
  expect(all.heading).toBe("All models");
  expect(all.noMatch).toBe(true);
  expect(all.visibleLanguages).toEqual(["ja"]);
});

test("status parses the supported engine and implies the benchmark tier on an older server", () => {
  const status = parseSpeechStatus({ supported: true, state: "ready", modelId: "parakeet-v3", model: "Parakeet v3", size: 1, supportsStreaming: true, supportsTranslation: false, languages: ["en"], acceleration: "auto", modelUnloadTimeout: "min_5", gpuDevices: [{ id: "0", name: "M3 GPU" }] });
  expect(status && status.supported && status.benchmarkTier).toBe("accelerated");
  const cpuOnly = parseSpeechStatus({ supported: true, state: "missing-model", modelId: "x", model: "X", size: 1, supportsStreaming: false, supportsTranslation: false, acceleration: "auto", modelUnloadTimeout: "never", gpuDevices: [] });
  expect(cpuOnly && cpuOnly.supported && [cpuOnly.benchmarkTier, cpuOnly.state]).toEqual(["cpu", "missing-model"]);
});

test("the language select resolves the saved choice against the model", () => {
  expect(effectiveSpeechLanguage({ languages: ["en"], supportsLanguageDetection: false }, "de")).toBe("en");
  expect(effectiveSpeechLanguage({ languages: ["en", "de"], supportsLanguageDetection: true }, "auto")).toBe("auto");
  expect(effectiveSpeechLanguage({ languages: ["en", "de"], supportsLanguageDetection: false }, "fr")).toBe("en");
  expect(languageSelectView({ languages: ["en", "de"], supportsLanguageDetection: true }, "auto").label).toBe("Auto-detect");
  expect(languageSelectView({ languages: ["de"], supportsLanguageDetection: false }, "auto").label).toBe("Auto (German)");
  const unavailable = languageSelectView({ languages: ["en", "de"], supportsLanguageDetection: false }, "ja");
  expect([unavailable.label, unavailable.unavailable]).toEqual(["English (Japanese unavailable)", "Japanese unavailable"]);
  expect(unavailable.codes).toEqual(["en", "de"]);
  expect(languageSelectView(null, "auto").disabled).toBe(true);
  expect(orderSpeechLanguages(["de", "en", "ja"], ["ja"])).toEqual(["ja", "en", "de"]);
});

test("Transcribe with lists Off, environments, then a cloud group per capable environment", () => {
  const environments = [
    { environmentId: "env-1", label: "This Mac", voiceTranscription: true, cloudVoiceTranscription: true },
    { environmentId: "env-2", label: "Build box", voiceTranscription: false, cloudVoiceTranscription: false },
  ];
  const options = destinationOptions(environments);
  expect(options.map((option) => [option.group, option.label])).toEqual([
    ["On an environment", "This Mac"], ["On an environment", "Build box"],
    ["Cloud via This Mac", "OpenAI"], ["Cloud via This Mac", "Grok Voice Transcribe"], ["Cloud via This Mac", "OpenRouter"],
  ]);
  const cloud = { kind: "cloud" as const, environmentId: "env-1", provider: "xai" as const };
  expect(destinationValue(cloud)).toBe(JSON.stringify(["cloud", "env-1", "xai"]));
  expect(options.some((option) => option.value === destinationValue(cloud))).toBe(true);
  expect(destinationLabel(cloud, environments)).toEqual({ text: "Grok Voice Transcribe", via: "This Mac", icon: "xai" });
  expect(destinationLabel({ kind: "environment", environmentId: "gone" }, environments).text).toBe("Chosen environment (unavailable)");
  expect(destinationLabel(null, environments)).toEqual({ text: "Off", via: null, icon: "off" });
});

test("the saved audio choice round-trips and an unreadable value is no choice", () => {
  const grant = { id: "g1", destination: { kind: "cloud" as const, environmentId: "env-1", provider: "openrouter" as const, model: "openai/whisper-1" } };
  expect(parseAudioChoice(serializeAudioChoice(grant))).toEqual(grant);
  expect(parseAudioChoice(serializeAudioChoice("off"))).toBe("off");
  expect(parseAudioChoice("")).toBe(null);
  expect(parseAudioChoice("{nope")).toBe(null);
  expect(parseAudioChoice(JSON.stringify({ id: "x", destination: { kind: "cloud", environmentId: "e", provider: "openrouter" } }))).toBe(null);
  expect(parsePostProcessingPrompt('{"mode":"custom","customInstructions":"Keep it short"}')).toEqual({ mode: "custom", customInstructions: "Keep it short" });
  expect(parsePostProcessingPrompt(undefined)).toEqual({ mode: "default", customInstructions: "" });
});

test("dictionary terms split on commas and lines, skip known spellings and respect the limits", () => {
  const words = [{ term: "Kubernetes", aliases: ["cooper nettys"] }];
  expect(addTerms(words, "Vite, kubernetes\nnsh ")?.map((entry) => entry.term)).toEqual(["Kubernetes", "Vite", "nsh"]);
  expect(addTerms(words, "cooper nettys")).toBe(null);
  expect(addTerms(words, "x".repeat(51))).toBe(null);
  expect(addAlias(words, "Kubernetes", "kube")?.[0]?.aliases).toEqual(["cooper nettys", "kube"]);
  expect(addAlias(words, "Kubernetes", "Cooper Nettys")).toBe(null);
});
