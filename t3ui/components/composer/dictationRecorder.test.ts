import { expect, test } from "nsh/test";
import { createDictation } from "./dictation";
import type { RecorderLike } from "./dictation";

const noSpeech = { available: async () => true, start: () => { throw new Error("the system recognizer should not run"); } };

test("with a recorder, dictation records, sends the clip to the destination and inserts the transcript", async () => {
  let stopRecording: () => void = () => {};
  const sent: Uint8Array[] = [];
  const recorder: RecorderLike = {
    available: () => true,
    start: async (options) => {
      options.onStart();
      options.onLevel(0.5, 1);
      const done = new Promise<{ path: string; pcm: () => Promise<Uint8Array> }>((resolve) => { stopRecording = () => resolve({ path: "/tmp/a.wav", pcm: async () => new Uint8Array([1, 2]) }); });
      return { stop: async () => stopRecording(), done };
    },
    transcribe: async (pcm) => { sent.push(pcm); return "hello um world"; },
    discard: () => {},
  };
  let prompt = "say";
  const dictation = createDictation({
    speech: noSpeech as never, recorder, choice: () => "granted", language: () => "auto", removeFillers: () => true,
    threadId: () => "t1", prompt: () => prompt, caret: () => prompt.length, insert: (text) => { prompt = text; }, openSetup: () => {},
  });
  const started = dictation.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(dictation.state().phase).toBe("recording");
  expect(dictation.level?.()).toBe(0.5);
  dictation.confirm();
  await started;
  expect(sent.length).toBe(1);
  expect(prompt).toBe("say hello world");
  expect(dictation.state().phase).toBe("idle");
});

test("a failed transcription offers to record again; cancel discards the recording", async () => {
  let resolveDone: (value: { path: string; pcm: () => Promise<Uint8Array> }) => void = () => {};
  const discarded: string[] = [];
  const recorder: RecorderLike = {
    available: () => true,
    start: async (options) => { options.onStart(); return { stop: async () => resolveDone({ path: "/tmp/b.wav", pcm: async () => new Uint8Array() }), done: new Promise((resolve) => { resolveDone = resolve; }) }; },
    transcribe: async () => { throw new Error("down"); },
    discard: (path) => discarded.push(path),
  };
  const dictation = createDictation({
    speech: noSpeech as never, recorder, choice: () => "granted", language: () => "auto", removeFillers: () => false,
    threadId: () => "t1", prompt: () => "", caret: () => 0, insert: () => {}, openSetup: () => {},
  });
  const first = dictation.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  dictation.confirm();
  await first;
  expect([dictation.state().phase, dictation.state().error, dictation.state().errorAction]).toEqual(["error", "Could not transcribe this recording.", "retry"]);
  dictation.cancel();
  const second = dictation.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  dictation.cancel();
  await second;
  expect(dictation.state().phase).toBe("idle");
  expect(discarded).toEqual(["/tmp/b.wav", "/tmp/b.wav"]);
});

test("every reference voice error has its short label and action", async () => {
  const { voiceErrorActionLabel, voiceErrorLabel } = await import("./dictation");
  expect(voiceErrorLabel("The microphone disconnected.")).toBe("Microphone disconnected");
  expect(voiceErrorLabel("Voice transcription is still finishing. Try again shortly.")).toBe("Transcription still busy");
  expect(voiceErrorLabel("something else")).toBe("Voice input failed");
  expect(voiceErrorActionLabel("Could not transcribe this recording.", "retry")).toBe("Retry transcription");
  expect(voiceErrorActionLabel("No speech was detected.", "retry")).toBe("Record again");
  expect(voiceErrorActionLabel(null, "settings")).toBe("Open voice settings");
});
