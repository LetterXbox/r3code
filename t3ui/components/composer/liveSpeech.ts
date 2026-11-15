// Live dictation text, as the reference streams it (client-runtime voice-input/stream.ts openSpeechStream over
// /ws/voice, browserVoiceInput.ts): while recording, 16 kHz mono float32 PCM goes to the environment in chunks (at most two
// in flight, each acknowledged by an "update" carrying the committed and tentative text), and "finish" ends with the final
// transcript. NSH has no raw audio API, so the PCM comes from the growing WAV the osascript recorder writes
// (desktop/audioCapture.ts): it is read again every poll and the bytes after the last read are fed.
import { readFile } from "fs/promises";

/** SPEECH_STREAM_PATH / SPEECH_STREAM_MAX_CHUNK_BYTES / SPEECH_STREAM_MAX_QUEUED_BYTES (contracts speech.ts). */
export const SPEECH_STREAM_PATH = "/ws/voice";
export const SPEECH_STREAM_MAX_CHUNK_BYTES = 16_000 * 4;
export const SPEECH_STREAM_MAX_QUEUED_BYTES = 16_000 * 4 * 5 * 60;

export interface SpeechStreamText { committed: string; tentative: string }

/** The socket the stream speaks over (the global WebSocket in the app, a fake in tests). */
export interface SocketLike {
  send(data: string | Uint8Array): void;
  close(): void;
  addEventListener(event: "open" | "close" | "error", listener: () => void): void;
  addEventListener(event: "message", listener: (event: { data: unknown }) => void): void;
}

/** openSpeechStream, ported: a bounded send window, a revision check on every update, a 120 s response deadline. */
export function openSpeechStream(input: {
  socket: SocketLike;
  options: unknown;
  canSend: () => boolean;
  onText: (text: SpeechStreamText) => void;
  onError: (error: Error) => void;
}) {
  const socket = input.socket;
  let resolveFinal!: (text: string) => void;
  let rejectFinal!: (error: Error) => void;
  const final = new Promise<string>((resolve, reject) => { resolveFinal = resolve; rejectFinal = reject; });
  void final.catch(() => undefined);
  let queue: Uint8Array[] = [];
  let queuedBytes = 0;
  const inFlight: number[] = [];
  let inFlightBytes = 0;
  let finishing = false;
  let finishSent = false;
  let closed = false;
  let isReady = false;
  let revision = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => { if (timer) clearTimeout(timer); queue = []; queuedBytes = 0; };
  const fail = (error: Error, notify = true) => {
    if (closed) return;
    closed = true;
    cleanup();
    rejectFinal(error);
    socket.close();
    if (notify) input.onError(error);
  };
  const armTimeout = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => fail(new Error("Live transcription stopped responding.")), 120_000); };
  const pump = () => {
    if (!isReady || closed || finishSent) return;
    if (!input.canSend()) { fail(new Error("Voice consent was revoked.")); return; }
    while (inFlight.length < 2 && queue.length) {
      const chunk = queue.shift()!;
      inFlight.push(chunk.byteLength);
      inFlightBytes += chunk.byteLength;
      queuedBytes -= chunk.byteLength;
      socket.send(chunk);
      armTimeout();
    }
    if (finishing && !queue.length && !inFlight.length) {
      finishSent = true;
      socket.send(JSON.stringify({ type: "finish" }));
      armTimeout();
    }
  };
  socket.addEventListener("open", () => {
    if (!input.canSend()) { fail(new Error("Voice consent was revoked.")); return; }
    if (!closed) socket.send(JSON.stringify({ type: "start", options: input.options }));
  });
  socket.addEventListener("message", (event) => {
    if (closed) return;
    if (!input.canSend()) { fail(new Error("Voice consent was revoked.")); return; }
    try {
      const message = JSON.parse(String(event.data)) as { type?: string; revision?: number; text?: unknown; message?: unknown };
      switch (message.type) {
        case "ready":
          if (isReady) throw new Error("Unexpected speech stream response.");
          isReady = true;
          if (timer) clearTimeout(timer);
          pump();
          break;
        case "update": {
          if (!inFlight.length || typeof message.revision !== "number" || message.revision < revision) throw new Error("Unexpected speech stream response.");
          revision = message.revision;
          inFlightBytes -= inFlight.shift()!;
          if (timer) clearTimeout(timer);
          const text = message.text as SpeechStreamText | null;
          if (text && typeof text.committed === "string" && typeof text.tentative === "string") input.onText(text);
          pump();
          if (inFlight.length) armTimeout();
          break;
        }
        case "finished":
          if (!finishSent) throw new Error("Unexpected speech stream response.");
          closed = true;
          cleanup();
          resolveFinal(typeof message.text === "string" ? message.text : "");
          socket.close();
          break;
        case "error":
          fail(new Error(typeof message.message === "string" ? message.message : "Live transcription failed."));
          break;
        default:
          throw new Error("Invalid speech stream response.");
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Invalid speech stream response."));
    }
  });
  socket.addEventListener("close", () => fail(new Error("The voice connection closed. Please record again.")));
  socket.addEventListener("error", () => fail(new Error("Could not connect to live transcription.")));
  armTimeout();
  return {
    feed(bytes: Uint8Array) {
      if (closed || finishing) return;
      if (queuedBytes + inFlightBytes + bytes.byteLength > SPEECH_STREAM_MAX_QUEUED_BYTES) { fail(new Error("Voice recordings are limited to five minutes.")); return; }
      let offset = 0;
      while (offset < bytes.length) {
        const tail = queue[queue.length - 1];
        const available = tail ? SPEECH_STREAM_MAX_CHUNK_BYTES - tail.byteLength : 0;
        if (tail && available > 0) {
          const appended = Math.min(available, bytes.length - offset);
          const merged = new Uint8Array(tail.byteLength + appended);
          merged.set(tail);
          merged.set(bytes.subarray(offset, offset + appended), tail.byteLength);
          queue[queue.length - 1] = merged;
          queuedBytes += appended;
          offset += appended;
          continue;
        }
        const chunk = bytes.slice(offset, offset + SPEECH_STREAM_MAX_CHUNK_BYTES);
        queue.push(chunk);
        queuedBytes += chunk.byteLength;
        offset += chunk.byteLength;
      }
      try { pump(); } catch { fail(new Error("Could not send microphone audio.")); }
    },
    finish() {
      finishing = true;
      try { pump(); } catch { fail(new Error("Could not finish live transcription.")); }
      return final;
    },
    cancel() { fail(new Error("Voice transcription was cancelled."), false); },
  };
}

/** Where a WAV's sample data starts once its `data` chunk header is written (AVAudioRecorder may pad with FLLR first). */
export function wavDataStart(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
    if (id === "data") return offset + 8;
    const size = view.getUint32(offset + 4, true);
    offset += 8 + size + (size % 2);
  }
  return null;
}

/**
 * Follows a WAV being written: each `poll()` reads the file again and returns the whole float32 samples after the last
 * read (the data chunk's size field is not trusted while the recorder still writes).
 */
export function followWav(path: string, read: (path: string) => Promise<Uint8Array> = async (file) => new Uint8Array(await readFile(file))) {
  let sent = -1;
  return {
    async poll(): Promise<Uint8Array> {
      let bytes: Uint8Array;
      try { bytes = await read(path); } catch { return new Uint8Array(0); }
      const start = wavDataStart(bytes);
      if (start === null) return new Uint8Array(0);
      if (sent < 0) sent = start;
      const end = start + Math.floor((bytes.byteLength - start) / 4) * 4;
      if (end <= sent) return new Uint8Array(0);
      const fresh = bytes.slice(sent, end);
      sent = end;
      return fresh;
    },
  };
}
