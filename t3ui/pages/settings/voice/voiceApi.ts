// The environment's voice HTTP API (EnvironmentVoiceHttpApi, packages/contracts/src/environmentHttp.ts) as
// client-runtime/voice-input/environment.ts calls it. These are HTTP endpoints with the session bearer, not
// RPC methods; the transport is injectable so tests feed contract-shaped payloads.
import { backendBearer, backendStatus, backendUrl } from "../../../store";
import { parseSpeechModels, parseSpeechStatus, type CloudSpeechProvider, type EnvironmentSpeechModel, type EnvironmentSpeechStatus, type SpeechModelUnloadTimeout } from "./speech";

export interface VoiceTransport {
  request: (method: "GET" | "POST", path: string, body?: unknown) => Promise<unknown>;
  connected: () => boolean;
}

function httpBase(): string {
  const url = new URL(backendUrl());
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

const INFERENCE_OR_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

async function liveRequest(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const bearer = backendBearer();
  if (!bearer) throw new Error("Connect an environment first");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), path.includes("/transcribe") ? INFERENCE_OR_DOWNLOAD_TIMEOUT_MS : 30_000);
  try {
    // Audio and credentials never follow a redirect to another host.
    const response = await fetch(`${httpBase()}${path}`, {
      method, redirect: "error", signal: controller.signal,
      headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { "content-type": body instanceof Uint8Array ? "application/octet-stream" : "application/json" }) },
      ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
    });
    if (!response.ok) {
      let message = `Request failed (HTTP ${response.status})`;
      try {
        const detail = (await response.json()) as { message?: unknown } | null;
        if (detail && typeof detail.message === "string" && detail.message) message = detail.message;
      } catch { /* keep the status line */ }
      throw new Error(message);
    }
    if (response.status === 204) return null;
    try { return await response.json(); } catch { return null; }
  } finally {
    clearTimeout(timer);
  }
}

let transport: VoiceTransport = {
  request: liveRequest,
  connected: () => backendStatus() === "connected",
};

/** Tests swap the transport; the app never calls this. */
export function configureVoiceApi(next: Partial<VoiceTransport>) {
  transport = { ...transport, ...next };
}

export const voiceConnected = () => transport.connected();

export async function getSpeechStatus(): Promise<EnvironmentSpeechStatus> {
  const status = parseSpeechStatus(await transport.request("GET", "/api/voice/status"));
  if (!status) throw new Error("The environment sent an unreadable voice status");
  return status;
}

/** `benchmarks` asks for the accuracy and speed scores (the foreground load); progress polls leave them out. */
export async function getSpeechModels(benchmarks: boolean): Promise<EnvironmentSpeechModel[]> {
  return parseSpeechModels(await transport.request("GET", `/api/voice/models${benchmarks ? "?benchmarks=1" : ""}`));
}

const modelAction = (action: "download" | "select" | "cancel" | "remove") => async (modelId: string) =>
  parseSpeechModels(await transport.request("POST", `/api/voice/models/${action}`, { modelId }));
export const downloadSpeechModel = modelAction("download");
export const selectSpeechModel = modelAction("select");
export const cancelSpeechModelDownload = modelAction("cancel");
export const removeSpeechModel = modelAction("remove");

export async function updateSpeechAcceleration(acceleration: string): Promise<EnvironmentSpeechStatus | null> {
  return parseSpeechStatus(await transport.request("POST", "/api/voice/acceleration", { acceleration }));
}
export async function updateSpeechModelUnloadTimeout(timeout: SpeechModelUnloadTimeout): Promise<EnvironmentSpeechStatus | null> {
  return parseSpeechStatus(await transport.request("POST", "/api/voice/model-unload-timeout", { timeout }));
}

/** CloudSpeechKeys: which providers have a key saved (openrouter is absent on older servers). */
export async function getCloudSpeechKeys(): Promise<Partial<Record<CloudSpeechProvider, boolean>>> {
  const raw = (await transport.request("GET", "/api/voice/cloud/keys")) as Record<string, unknown> | null;
  const out: Partial<Record<CloudSpeechProvider, boolean>> = {};
  for (const provider of ["openai", "xai", "openrouter"] as const) if (raw && typeof raw[provider] === "boolean") out[provider] = raw[provider] as boolean;
  return out;
}

export async function setCloudSpeechKey(provider: CloudSpeechProvider, key: string | null): Promise<void> {
  await transport.request("POST", `/api/voice/cloud/${provider}/key`, { key });
}

export async function getCloudSpeechModels(): Promise<{ id: string; name: string }[]> {
  const raw = (await transport.request("GET", "/api/voice/cloud/openrouter/models")) as { models?: unknown } | null;
  const models = Array.isArray(raw?.models) ? raw.models : [];
  return models.flatMap((model) => {
    const item = model as { id?: unknown; name?: unknown };
    return typeof item?.id === "string" && typeof item.name === "string" ? [{ id: item.id, name: item.name }] : [];
  });
}

export interface SpeechTranscriptionOptions {
  speechLanguage: string;
  speechTranslateToEnglish: boolean;
  speechCustomWords: unknown;
  speechRemoveFillerWords: boolean;
  speechCorrectionWord?: string;
  speechSilenceFiltering: boolean;
}

/** encodeSpeechPcmRequest (packages/shared/src/speech.ts): a little-endian u32 options length, the options JSON, the PCM. */
export function encodeSpeechPcmRequest(pcm: Uint8Array, options: SpeechTranscriptionOptions): Uint8Array {
  const metadata = new TextEncoder().encode(JSON.stringify(options));
  if (metadata.byteLength > 128_000) throw new Error("Speech options are too large.");
  const body = new Uint8Array(4 + metadata.byteLength + pcm.byteLength);
  new DataView(body.buffer).setUint32(0, metadata.byteLength, true);
  body.set(metadata, 4);
  body.set(pcm, 4 + metadata.byteLength);
  return body;
}

/** transcribeEnvironmentPcm: 16 kHz mono float32 PCM to the environment's selected model. */
export async function transcribeSpeechPcm(pcm: Uint8Array, options: SpeechTranscriptionOptions): Promise<string> {
  const result = (await transport.request("POST", "/api/voice/transcribe", encodeSpeechPcmRequest(pcm, options))) as { text?: unknown } | null;
  return typeof result?.text === "string" ? result.text : "";
}

/** transcribeCloudPcm: the same PCM request to `/api/voice/cloud/:provider/transcribe` (OpenRouter names its model). */
export async function transcribeCloudSpeechPcm(provider: "openai" | "xai" | "openrouter", pcm: Uint8Array, options: SpeechTranscriptionOptions, model?: string): Promise<string> {
  const query = model === undefined ? "" : `?model=${encodeURIComponent(model)}`;
  const result = (await transport.request("POST", `/api/voice/cloud/${provider}/transcribe${query}`, encodeSpeechPcmRequest(pcm, options))) as { text?: unknown } | null;
  return typeof result?.text === "string" ? result.text : "";
}

/** getEnvironmentSpeechStreamUrl: a media WebSocket ticket for /ws/voice (`/api/auth/websocket-ticket/media`). */
export async function speechStreamUrl(path: string): Promise<string> {
  const result = (await transport.request("POST", "/api/auth/websocket-ticket/media")) as { ticket?: unknown } | null;
  if (!result || typeof result.ticket !== "string" || !result.ticket) throw new Error("The environment returned no connection ticket.");
  const url = new URL(path, httpBase());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", result.ticket);
  return url.toString();
}

/** browserVoiceInput: the environment streams (supportsStreaming or supportsBufferedStreaming in its status). */
export async function speechStreamingAvailable(): Promise<boolean> {
  const raw = (await transport.request("GET", "/api/voice/status")) as { supported?: unknown; supportsStreaming?: unknown; supportsBufferedStreaming?: unknown } | null;
  return raw?.supported === true && (raw.supportsStreaming === true || raw.supportsBufferedStreaming === true);
}
