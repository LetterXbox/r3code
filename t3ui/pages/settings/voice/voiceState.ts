// What Settings > Voice reads and writes, through the scoped settings mechanism (settingsSync.ts): a
// ServerSettings key goes to `server.updateSettings` (optimistic, reverted on failure), anything else is a
// client setting kept on this device. Scope follows the contracts: `speechLanguage`, the dictionary, the
// cleanup prompt and the translate / silence / filler switches are ClientSettings; `speechModelId`,
// `speechAcceleration`, `speechProjectCustomWords` and `speechPostProcessingModelSelection` are
// ServerSettings.
//
// The destination the person consented to (the web's voiceConsent.ts, which keeps it in localStorage) is
// two client settings here: `voiceAudioChoice` (JSON of the grant, "off", or empty before the first choice)
// and `voiceCleanupGrant` (an id while cleanup is allowed, empty otherwise).
import { serverEnvironment } from "../settingsState";
import { readSetting, writeSetting } from "../settingsSync";
import { isServerConnected } from "../settingsSync";
import {
  parseAudioChoice, parseCustomWords, parsePostProcessingPrompt, serializeAudioChoice,
  type AudioChoice, type EnvironmentInfo, type PostProcessingPrompt, type SpeechCustomWords, type VoiceTranscriptionDestination,
} from "./speech";

const id = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** The connected environment, as the settings scope would list it: the one this client is signed in to. */
export function connectedEnvironments(): EnvironmentInfo[] {
  if (!isServerConnected()) return [];
  const descriptor = serverEnvironment();
  if (!descriptor || typeof descriptor.environmentId !== "string") return [];
  const capabilities = (descriptor.capabilities ?? {}) as Record<string, unknown>;
  return [{
    environmentId: descriptor.environmentId,
    label: typeof descriptor.label === "string" ? descriptor.label : descriptor.environmentId,
    voiceTranscription: capabilities.voiceTranscription === true,
    cloudVoiceTranscription: capabilities.cloudVoiceTranscription === true,
  }];
}

export const audioChoice = (): AudioChoice => parseAudioChoice(readSetting("voiceAudioChoice", "client"));
export const audioGrant = () => { const choice = audioChoice(); return choice && choice !== "off" ? choice : null; };

export function chooseAudioDestination(destination: VoiceTranscriptionDestination | null) {
  void writeSetting("voiceAudioChoice", "client", serializeAudioChoice(destination ? { id: id(), destination } : "off"));
}

export const cleanupEnabled = () => String(readSetting("voiceCleanupGrant", "client") ?? "") !== "";
export function chooseTranscriptCleanup(enabled: boolean) {
  void writeSetting("voiceCleanupGrant", "client", enabled ? id() : "");
}

/** The chosen input device (a CoreAudio UID; "" is the system default), as `voiceMicrophone` stores it. */
export const voiceMicrophone = () => { const value = readSetting("voiceMicrophone", "client"); return typeof value === "string" ? value : ""; };
export const speechLanguage = () => { const value = readSetting("speechLanguage", "client"); return typeof value === "string" && value ? value : "auto"; };
export const setSpeechLanguage = (code: string) => void writeSetting("speechLanguage", "client", code);

export const speechCustomWords = (): SpeechCustomWords => parseCustomWords(readSetting("speechCustomWords", "client"));
export const setSpeechCustomWords = (words: SpeechCustomWords) => void writeSetting("speechCustomWords", "client", JSON.stringify(words));

export const postProcessingPrompt = (): PostProcessingPrompt => parsePostProcessingPrompt(readSetting("speechPostProcessingPrompt", "client"));
export const setPostProcessingPrompt = (prompt: PostProcessingPrompt) => void writeSetting("speechPostProcessingPrompt", "client", JSON.stringify(prompt));

export function correctionCue(): string {
  const value = readSetting("speechCorrectionWord", "client");
  return typeof value === "string" ? value : "";
}

/** `speechProjectCustomWords`, the vocabulary stored on the environment. */
export function projectCustomWords(): SpeechCustomWords {
  const raw = readSetting("speechProjectCustomWords", "server");
  return Array.isArray(raw) ? parseCustomWords(JSON.stringify(raw)) : [];
}
export const setProjectCustomWords = (words: SpeechCustomWords) => void writeSetting("speechProjectCustomWords", "server", words as never);
