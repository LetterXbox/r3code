import { expect, test } from "nsh/test";
import { createDictation, insertTranscript, recognizerLanguage, removeFillerWords, speechError, voiceErrorLabel } from "./dictation";
import type { DictationDeps, SpeechErrorCode, SpeechLike } from "./dictation";

function fakeSpeech(available = true) {
  const listeners: Record<string, ((value: never) => void)[]> = {};
  const calls: string[] = [];
  let options: unknown = null;
  const session = {
    on(event: string, listener: (value: never) => void) { (listeners[event] ??= []).push(listener); return () => {}; },
    stop() { calls.push("stop"); }, abort() { calls.push("abort"); },
  };
  const speech = { available: async () => available, start: (given: unknown) => { options = given; return session; } } as unknown as SpeechLike;
  const emit = (event: string, value?: unknown) => (listeners[event] ?? []).forEach((listener) => listener(value as never));
  return { speech, emit, calls, options: () => options };
}

function setup(overrides: Partial<DictationDeps> = {}, available = true) {
  const fake = fakeSpeech(available);
  const state = { prompt: "fix the login", caret: 13, inserted: null as null | { text: string; caret: number }, setups: 0 };
  const dictation = createDictation({
    speech: fake.speech, choice: () => "granted", language: () => "auto", removeFillers: () => false, threadId: () => "thread-1",
    prompt: () => state.prompt, caret: () => state.caret, insert: (text, caret) => { state.inserted = { text, caret }; }, openSetup: () => { state.setups += 1; }, ...overrides,
  });
  return { ...fake, state, dictation };
}

test("dictation needs the Voice setting's consent: unset or off opens Voice settings instead of listening", async () => {
  for (const choice of ["unset", "off"] as const) {
    const { dictation, state, options } = setup({ choice: () => choice });
    await dictation.start();
    expect(state.setups).toBe(1);
    expect(dictation.state().phase).toBe("idle");
    expect(options()).toBeNull();
  }
});

test("a granted dictation listens in the chosen language, previews the transcript, and inserts it at the caret when finished", async () => {
  const { dictation, state, emit, calls, options } = setup({ language: () => "de-DE" });
  await dictation.start();
  expect(options()).toEqual({ lang: "de-DE", interim: true });
  expect(dictation.state().phase).toBe("preparing");
  emit("start");
  expect(dictation.state().phase).toBe("recording");
  emit("result", { text: "and add a test", isFinal: false });
  expect(dictation.preview()).toEqual({ committed: "", tentative: "and add a test" });
  emit("result", { text: "and add a test", isFinal: true });
  expect(dictation.preview()).toEqual({ committed: "and add a test", tentative: "" });
  dictation.confirm();
  expect(calls).toEqual(["stop"]);
  expect(dictation.state().phase).toBe("transcribing");
  emit("end", { text: "and add a test" });
  expect(state.inserted).toEqual({ text: "fix the login and add a test", caret: 28 });
  expect(dictation.state().phase).toBe("idle");
  expect(dictation.preview()).toBeNull();
});

test("auto language leaves the recognizer's language alone, and fillers go when the setting says so", async () => {
  expect(recognizerLanguage("auto")).toBeNull();
  expect(recognizerLanguage("en-US")).toBe("en-US");
  expect(removeFillerWords("so um, fix the uh login erm now")).toBe("so fix the login now");
  const { dictation, state, emit, options } = setup({ removeFillers: () => true });
  await dictation.start();
  expect(options()).toEqual({ lang: null, interim: true });
  emit("start");
  emit("end", { text: "um add tests" });
  expect(state.inserted?.text).toBe("fix the login add tests");
});

test("cancel throws the transcript away", async () => {
  const { dictation, state, emit, calls } = setup();
  await dictation.start();
  emit("start");
  dictation.cancel();
  expect(calls).toEqual(["abort"]);
  emit("end", { text: "never inserted" });
  expect(state.inserted).toBeNull();
  expect(dictation.state().phase).toBe("idle");
});

test("failures become the reference's error pill with a retry or a settings action", async () => {
  const unavailable = setup({}, false);
  await unavailable.dictation.start();
  expect(unavailable.dictation.state()).toMatchObject({ phase: "error", error: "Voice transcription is not available.", errorAction: "settings" });
  const { dictation, emit } = setup();
  await dictation.start();
  emit("start");
  emit("end", { text: "", error: "no-speech" });
  expect(dictation.state()).toMatchObject({ phase: "error", error: "No speech was detected.", errorAction: "retry" });
  expect(voiceErrorLabel("No speech was detected.")).toBe("No speech detected");
  expect(voiceErrorLabel("something else")).toBe("Voice input failed");
  dictation.cancel();
  expect(dictation.state().phase).toBe("idle");
  const codes: SpeechErrorCode[] = ["not-allowed", "audio-capture", "network", "language-not-supported", "unavailable", "failed"];
  expect(codes.map((code) => speechError(code).errorAction)).toEqual(["settings", "retry", "retry", "settings", "settings", "retry"]);
});

test("a transcript for a draft that is no longer open is not added", async () => {
  let thread = "thread-1";
  const { dictation, state, emit } = setup({ threadId: () => thread });
  await dictation.start();
  emit("start");
  thread = "thread-2";
  emit("end", { text: "hello" });
  expect(state.inserted).toBeNull();
  expect(dictation.state()).toMatchObject({ phase: "error", error: "This draft is no longer available." });
});

test("inserting spaces the transcript from its neighbours", () => {
  expect(insertTranscript("", 0, "hello")).toEqual({ text: "hello", caret: 5 });
  expect(insertTranscript("ab cd", 2, "x")).toEqual({ text: "ab x cd", caret: 4 });
  expect(insertTranscript("ab ", 3, "x")).toEqual({ text: "ab x", caret: 4 });
});
