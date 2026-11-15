import { mount, signal, Text, View } from "nsh";
import { createDictation } from "./dictation";
import type { SpeechLike } from "./dictation";
import { LiveTranscription, VoiceInputPill } from "./VoiceInputPill";

const listeners: Record<string, ((value: never) => void)[]> = {};
const session = {
  on(event: string, listener: (value: never) => void) { (listeners[event] ??= []).push(listener); return () => {}; },
  stop() { for (const listener of listeners.end ?? []) listener({ text: "hello world" } as never); }, abort() {},
};
const speech = { available: async () => true, start: () => session } as unknown as SpeechLike;
const inserted = signal("");
const dictation = createDictation({
  speech, choice: () => "granted", language: () => "auto", removeFillers: () => false, threadId: () => "t", prompt: () => "", caret: () => 0,
  insert: (text) => { inserted.set(text); }, openSetup: () => {},
});
const emit = (event: string, value?: unknown) => (listeners[event] ?? []).forEach((listener) => listener(value as never));

function Fixture() {
  return (
    <View class="flex-1">
      <VoiceInputPill dictation={dictation} onOpenSettings={() => {}} />
      <LiveTranscription dictation={dictation} />
      <View accessibilityLabel="Begin" onPress={() => void dictation.start()}><Text>Begin</Text></View>
      <View accessibilityLabel="Listening" onPress={() => emit("start")}><Text>Listening</Text></View>
      <View accessibilityLabel="Hear" onPress={() => emit("result", { text: "hello", isFinal: false })}><Text>Hear</Text></View>
      <View accessibilityLabel="Fail" onPress={() => emit("end", { text: "", error: "no-speech" })}><Text>Fail</Text></View>
      <Text>{`inserted:${inserted()}`}</Text>
    </View>
  );
}
mount(Fixture);
