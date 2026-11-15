import { mount, Text, View } from "nsh";
import { configureMicrophoneTest, MicrophoneTest, type MicrophoneSession } from "./MicrophoneTest";

// A recognizer the test drives: Start opens a session, "Mic starts" / "Mic ends ..." play its events.
let startListener: (() => void) | null = null;
let endListener: ((end: { text: string; error?: string | null; recording?: { path: string; seconds: number } }) => void) | null = null;
let levelListener: ((level: number) => void) | null = null;
const played: string[] = [];
configureMicrophoneTest({
  available: () => Promise.resolve(true),
  start: () => {
    const session: MicrophoneSession = {
      on(event: string, listener: any) { if (event === "start") startListener = listener; else if (event === "level") levelListener = listener; else endListener = listener; return () => undefined; },
      stop: () => endListener?.({ text: "", recording: { path: "/tmp/clip.wav", seconds: 3 } }),
      abort: () => undefined,
    } as MicrophoneSession;
    return session;
  },
  play: async (path, onPosition) => { played.push(path); onPosition(1.5, 3, true); return { play: () => played.push("play"), pause: () => played.push("pause"), seek: (at) => played.push(`seek ${at}`), stop: () => played.push("stop") }; },
  discard: (path) => played.push(`discard ${path}`),
});
mount(() => (
  <View class="flex-1 p-4">
    <View accessibilityLabel="Mic starts" onPress={() => startListener?.()}><Text>Mic starts</Text></View>
    <View accessibilityLabel="Mic ends denied" onPress={() => endListener?.({ text: "", error: "not-allowed" })}><Text>Mic ends denied</Text></View>
    <View accessibilityLabel="Mic ends fine" onPress={() => endListener?.({ text: "hello" })}><Text>Mic ends fine</Text></View>
    <View accessibilityLabel="Mic level" onPress={() => levelListener?.(0.6)}><Text>Mic level</Text></View>
    <MicrophoneTest />
  </View>
));
