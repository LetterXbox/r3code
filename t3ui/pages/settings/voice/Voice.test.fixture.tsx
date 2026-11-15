import { mount, View } from "nsh";
import { configureMicrophoneTest, MicrophoneTest } from "./MicrophoneTest";

// A client without audio capture (not macOS): the reference's capture-unavailable path. Tests never record for real.
configureMicrophoneTest({ available: () => Promise.resolve(false) });
mount(() => <View class="flex-1 p-4"><MicrophoneTest /></View>);
