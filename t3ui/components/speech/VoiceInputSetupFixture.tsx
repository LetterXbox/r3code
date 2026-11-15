import { mount, signal, Text, View } from "nsh";
import { createVoiceSetup } from "./voiceSetup";
import type { VoiceSetupApi } from "./voiceSetup";
import { VoiceInputSetup } from "./VoiceInputSetup";
import type { EnvironmentSpeechStatus } from "../../pages/settings/voice/speech";
import { parseSpeechModels, parseSpeechStatus } from "../../pages/settings/voice/speech";

const status = parseSpeechStatus({ supported: true, state: "missing-model", modelId: "parakeet", model: "Parakeet", size: 730_000_000, supportsStreaming: true, supportsTranslation: false, acceleration: "auto", benchmarkTier: "cpu", modelUnloadTimeout: "never", gpuDevices: [] }) as Extract<EnvironmentSpeechStatus, { supported: true }>;
const models = (state: string) => parseSpeechModels({ models: [{ id: "parakeet", name: "Parakeet Unified English 0.6B", description: "d", size: 730_000_000, languages: ["en"], accuracy: 4, speed: 4, recommended: true, supportsStreaming: true, supportsLanguageDetection: false, supportsTranslation: false, active: true, state }] });
const api: VoiceSetupApi = {
  status: async () => ({ ...status, state: "ready" as const }), models: async () => models("downloadable"),
  download: async () => models("installed"), select: async () => {}, cancel: async () => {},
};
const setup = createVoiceSetup(api, { language: () => "auto", preferred: () => ["en"], pollMs: 20 });
const started = signal(0);

function Fixture() {
  return (
    <View class="flex-1">
      <VoiceInputSetup setup={setup} environmentLabel={() => "OzBook M3"} />
      <View accessibilityLabel="Open setup" onPress={() => void setup.begin(status, () => { started.update((count) => count + 1); })}><Text>Open setup</Text></View>
      <Text>{`started:${started()}`}</Text>
    </View>
  );
}
mount(Fixture);
