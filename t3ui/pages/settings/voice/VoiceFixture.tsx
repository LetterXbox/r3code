import { mount, Scroll, signal, Text, View } from "nsh";
import { updateSetting } from "../../../store";
import { observeServerConfigEvent } from "../settingsState";
import { configureSettingsSync } from "../settingsSync";
import { SettingsPageContainer } from "../../../components/SettingsLayout";
import { registeredOverlays } from "../../../components/rightPanel/nativeOcclusion";
import { configureMicrophoneTest } from "./MicrophoneTest";
import { setAudioCaptureForTest } from "../../../desktop/audioCapture";
import { configureVoiceApi } from "./voiceApi";
import { configureVoiceCatalog } from "./voiceCatalog";
import { VoiceSettings } from "./VoiceSettings";

// A connected environment that advertises local and cloud transcription, with contract-shaped payloads
// (packages/contracts/src/speech.ts, environmentHttp.ts) behind the voice HTTP API.
const connected = signal(true);
const calls = signal<string[]>([]);
const MB = 1024 * 1024;
const models: Record<string, any>[] = [
  { id: "parakeet-v3", name: "Parakeet v3", description: "Fast and accurate.", size: 480 * MB, languages: ["en", "de"], accuracy: 0.9, speed: 0.9, recommended: true, supportsStreaming: true, supportsLanguageDetection: true, supportsTranslation: true, active: true, state: "installed",
    benchmark: { accuracy: { en: { grade: "A", errorPercent: 4.1 } }, secondsPer30s: { cpu: 3.2, accelerated: 0.8 } } },
  { id: "whisper-small", name: "Whisper small", description: "Multilingual.", size: 466 * MB, languages: ["en", "de", "ja"], accuracy: 0.8, speed: 0.6, recommended: false, supportsStreaming: false, supportsLanguageDetection: true, supportsTranslation: false, active: false, state: "downloadable" },
  { id: "moonshine", name: "Moonshine", description: "Local.", size: 60 * MB, languages: ["en"], accuracy: 0.7, speed: 0.9, recommended: false, supportsStreaming: false, supportsLanguageDetection: false, supportsTranslation: false, active: false, state: "installed" },
];
let acceleration = "auto";
let unload = "min_5";
const status = () => ({ supported: true, state: "ready", modelId: "parakeet-v3", model: "Parakeet v3", size: 480 * MB, supportsStreaming: true, supportsTranslation: true, languages: ["en", "de"], supportsLanguageDetection: true, acceleration, modelUnloadTimeout: unload, gpuDevices: [{ id: "0", name: "Apple GPU" }] });
const keys = { openai: false, xai: true, openrouter: false };

configureVoiceCatalog({ pollMs: 250 });
configureSettingsSync({ connected: () => connected(), request: () => Promise.resolve(null) });
configureMicrophoneTest({ available: () => Promise.resolve(false) });
// No test opens the real microphone: capture is off until "Enable capture fixture", then a fake clip.
const captureOn = signal(false);
let finishCapture: (() => void) | null = null;
const captureDevice = signal("none");
const microphones = signal([{ deviceId: "usb-quadcast", label: "HyperX QuadCast S" }, { deviceId: "BuiltInMicrophoneDevice", label: "MacBook Pro Microphone" }]);
setAudioCaptureForTest({
  available: () => captureOn(),
  listMicrophones: async () => microphones(),
  startCapture: async (options) => {
    captureDevice.set(options.deviceId ?? "default");
    options.onStart?.();
    options.onLevel?.(0.5, 1);
    let resolve: (value: { path: string; seconds: number; pcm: () => Promise<Uint8Array> }) => void = () => undefined;
    const done = new Promise<{ path: string; seconds: number; pcm: () => Promise<Uint8Array> }>((next) => { resolve = next; });
    finishCapture = () => resolve({ path: "/tmp/test.wav", seconds: 2, pcm: async () => new Uint8Array(new Float32Array([0.1, 0.2]).buffer) });
    return { stop: async () => finishCapture?.(), done };
  },
  startPlayback: async () => ({ play: async () => undefined, pause: async () => undefined, seek: async () => undefined, stop: async () => undefined, done: new Promise(() => undefined) }),
});
configureVoiceApi({
  connected: () => connected(),
  request: async (method, path, body) => {
    calls.update((all) => [...all, `${method} ${path}${body === undefined ? "" : body instanceof Uint8Array ? ` <${body.byteLength} bytes>` : ` ${JSON.stringify(body)}`}`]);
    if (path === "/api/voice/transcribe") return { text: "hello world" };
    const modelId = (body as { modelId?: string } | undefined)?.modelId;
    if (path === "/api/voice/status") return status();
    if (path.startsWith("/api/voice/models") && method === "GET") {
      return { models: models.map((model) => ({ ...model })) };
    }
    if (path === "/api/voice/models/download") { const m = models.find((x) => x.id === modelId); if (m) { m.state = "downloading"; m.downloaded = 0; } return { models }; }
    if (path === "/api/voice/models/select") { for (const m of models) m.active = m.id === modelId; return { models }; }
    if (path === "/api/voice/models/remove") { const m = models.find((x) => x.id === modelId); if (m) { m.state = "downloadable"; m.active = false; } return { models }; }
    if (path === "/api/voice/models/cancel") { const m = models.find((x) => x.id === modelId); if (m) { m.state = "downloadable"; delete m.downloaded; } return { models }; }
    if (path === "/api/voice/acceleration") { acceleration = (body as { acceleration: string }).acceleration; return status(); }
    if (path === "/api/voice/model-unload-timeout") { unload = (body as { timeout: string }).timeout; return status(); }
    if (path === "/api/voice/cloud/keys") return keys;
    if (path.startsWith("/api/voice/cloud/") && path.endsWith("/key")) { (keys as Record<string, boolean>)[path.split("/")[4] ?? ""] = (body as { key: string | null }).key !== null; return null; }
    if (path === "/api/voice/cloud/openrouter/models") return { models: [{ id: "openai/whisper-1", name: "Whisper 1" }] };
    throw new Error(`unexpected ${method} ${path}`);
  },
});
observeServerConfigEvent({ type: "snapshot", config: {
  settings: { speechProjectCustomWords: [{ term: "NSH", aliases: [] }], textGenerationModelSelection: { instanceId: "codex", model: "gpt-5" }, speechPostProcessingModelSelection: null },
  keybindings: [],
  environment: { environmentId: "env-1", label: "This Mac", serverVersion: "1.0.0", capabilities: { voiceTranscription: true, cloudVoiceTranscription: true } },
} });
updateSetting("voiceAudioChoice", JSON.stringify({ id: "g1", destination: { kind: "environment", environmentId: "env-1" } }));

mount(() => (
  <View class="flex-1">
    <View accessibilityLabel="Disconnect fixture" onPress={() => connected.set(false)}><Text>Disconnect fixture</Text></View>
    <View accessibilityLabel="Advance download" onPress={() => {
      // The environment finishes the download in two steps; the test moves it so progress can be seen.
      for (const model of models) if (model.state === "downloading") {
        model.downloaded = Math.min(model.size, (model.downloaded ?? 0) + model.size / 2);
        if (model.downloaded >= model.size) { model.state = "installed"; delete model.downloaded; }
      }
    }}><Text>Advance download</Text></View>
    <View accessibilityLabel="Enable capture fixture" onPress={() => captureOn.set(true)}><Text>Enable capture fixture</Text></View>
    <View accessibilityLabel="Fail catalog" onPress={() => { models.length = 0; }}><Text>Fail catalog</Text></View>
    <View accessibilityLabel="Unplug microphones" onPress={() => microphones.set([])}><Text>Unplug microphones</Text></View>
    <Text>{`capture device: ${captureDevice()}`}</Text>
    <Text>{`overlays: ${registeredOverlays().length}`}</Text>
    <Each of={calls()} key={(call, index) => `${index}${call}`}>{(call) => <Text>{`call ${call()}`}</Text>}</Each>
    <Scroll class="flex-1"><SettingsPageContainer><VoiceSettings /></SettingsPageContainer></Scroll>
  </View>
));
