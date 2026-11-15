import { signal } from "nsh";
import { expect, test } from "nsh/test";
import { setDictationFactoryForTest, type DictationDeps } from "../composer/dictation";
import { createAnnotationVoice, readPickVoice } from "./previewAnnotationSpeech";

test("fm13: dictation in the annotation editor runs on the composer's pipeline and writes into the page's draft", async () => {
  expect(readPickVoice(JSON.stringify({ t3: "pick", voice: "start", text: "abc", cursor: 9 }))).toEqual({ action: "start", text: "abc", cursor: 3, selectionEnd: null });
  expect(readPickVoice(JSON.stringify({ t3: "pick", annotation: {} }))).toBe(null);
  let captured: DictationDeps | null = null;
  const phase = signal<"idle" | "recording">("idle");
  setDictationFactoryForTest((deps) => { captured = deps; return {
    state: () => ({ phase: phase(), error: null, errorAction: null }), preview: () => null, activity: () => 0,
    start: async () => { phase.set("recording"); }, confirm: () => { deps.insert(`${deps.prompt()} red`, deps.prompt().length + 4); phase.set("idle"); }, cancel: () => phase.set("idle"),
  }; });
  const scripts: string[] = [];
  const shared = { speech: {} as never, choice: () => "granted" as const, language: () => "auto", removeFillers: () => true, threadId: () => "t1", openSetup: () => undefined };
  const voice = createAnnotationVoice((s) => scripts.push(s), () => shared);
  expect(voice.available()).toBe(true);
  voice.handle({ action: "start", text: "Make it", cursor: 7, selectionEnd: null });
  await new Promise((r) => setTimeout(r, 10));
  expect(captured!.prompt()).toBe("Make it");
  expect(scripts.some((s) => s.includes('"phase":"recording"') && s.includes('"status":"Recording"'))).toBe(true);
  voice.handle({ action: "stop", text: "Make it", cursor: 7, selectionEnd: null });
  expect(scripts.some((s) => s.includes('"text":"Make it red"'))).toBe(true);
  setDictationFactoryForTest(null);
  expect(createAnnotationVoice(() => undefined, () => null).available()).toBe(false);
});
