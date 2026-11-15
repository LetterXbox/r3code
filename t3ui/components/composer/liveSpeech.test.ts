import { expect, test } from "nsh/test";
import { createDictation } from "./dictation";
import type { RecorderLike } from "./dictation";
import { followWav, openSpeechStream, SPEECH_STREAM_MAX_CHUNK_BYTES, wavDataStart } from "./liveSpeech";
import type { SocketLike } from "./liveSpeech";

function fakeSocket() {
  const listeners: Record<string, ((event?: { data: unknown }) => void)[]> = {};
  const sent: (string | Uint8Array)[] = [];
  const socket: SocketLike = {
    send: (data) => sent.push(data), close: () => {},
    addEventListener: (event: string, listener: (event?: { data: unknown }) => void) => { (listeners[event] ??= []).push(listener); },
  } as SocketLike;
  const emit = (event: string, data?: unknown) => (listeners[event] ?? []).forEach((listener) => listener(data === undefined ? undefined : { data }));
  return { socket, sent, emit };
}

test("the stream starts, sends at most two chunks in flight, shows each update and ends with the final text", async () => {
  const { socket, sent, emit } = fakeSocket();
  const texts: string[] = [];
  const stream = openSpeechStream({ socket, options: { speechLanguage: "auto" }, canSend: () => true, onText: (text) => texts.push(`${text.committed}|${text.tentative}`), onError: () => {} });
  emit("open");
  expect(JSON.parse(sent[0] as string)).toEqual({ type: "start", options: { speechLanguage: "auto" } });
  stream.feed(new Uint8Array(SPEECH_STREAM_MAX_CHUNK_BYTES * 3));
  emit("message", JSON.stringify({ type: "ready" }));
  expect(sent.length).toBe(3);
  emit("message", JSON.stringify({ type: "update", revision: 0, text: { committed: "hello", tentative: " wor" } }));
  expect(sent.length).toBe(4);
  expect(texts).toEqual(["hello| wor"]);
  const final = stream.finish();
  emit("message", JSON.stringify({ type: "update", revision: 1, text: null }));
  emit("message", JSON.stringify({ type: "update", revision: 2, text: { committed: "hello world", tentative: "" } }));
  expect(JSON.parse(sent[sent.length - 1] as string)).toEqual({ type: "finish" });
  emit("message", JSON.stringify({ type: "finished", text: "hello world" }));
  expect(await final).toBe("hello world");
});

test("a growing WAV is followed from its data chunk, whole samples only", async () => {
  const header = new Uint8Array(44);
  header.set([82, 73, 70, 70], 0); header.set([87, 65, 86, 69], 8); header.set([100, 97, 116, 97], 36);
  let file = new Uint8Array([...header, 1, 2, 3, 4, 5, 6]);
  expect(wavDataStart(file)).toBe(44);
  const follower = followWav("x.wav", async () => file);
  expect([...await follower.poll()]).toEqual([1, 2, 3, 4]);
  file = new Uint8Array([...file, 7, 8]);
  expect([...await follower.poll()]).toEqual([5, 6, 7, 8]);
  expect((await follower.poll()).byteLength).toBe(0);
});

test("dictation shows the stream's live text and inserts its final transcript", async () => {
  let resolveDone: (value: { path: string; pcm: () => Promise<Uint8Array> }) => void = () => {};
  const fed: number[] = [];
  let pushText: (text: { committed: string; tentative: string }) => void = () => {};
  const recorder: RecorderLike = {
    available: () => true,
    start: async (options) => { options.onStart(); return { path: "/tmp/live.wav", stop: async () => resolveDone({ path: "/tmp/live.wav", pcm: async () => new Uint8Array() }), done: new Promise((resolve) => { resolveDone = resolve; }) }; },
    transcribe: async () => { throw new Error("the batch path should not run"); },
    discard: () => {},
    follow: () => ({ poll: async () => new Uint8Array([1, 2, 3, 4]) }),
    live: async (onText) => { pushText = onText; return { feed: (pcm) => fed.push(pcm.byteLength), finish: async () => "live words", cancel: () => {} }; },
  };
  let prompt = "";
  const dictation = createDictation({
    speech: { available: async () => true, start: () => { throw new Error("no recognizer"); } } as never, recorder,
    choice: () => "granted", language: () => "auto", removeFillers: () => false,
    threadId: () => "t1", prompt: () => prompt, caret: () => prompt.length, insert: (text) => { prompt = text; }, openSetup: () => {},
  });
  const run = dictation.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  pushText({ committed: "live", tentative: " wo" });
  expect(dictation.preview()).toEqual({ committed: "live", tentative: " wo" });
  dictation.confirm();
  await run;
  expect(fed.length > 0).toBe(true);
  expect(prompt).toBe("live words");
  expect(dictation.preview()).toBe(null);
});
