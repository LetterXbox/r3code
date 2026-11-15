// A visual check of the recording footer in a real window without a microphone: when `force-recording` exists beside the
// launcher's bootstrap file (`~/.t3codegpui/bootstrap/<data name>/`, so only that test copy) at start-up, the composer's dictation is a stand-in held in its recording phase with a live transcript
// ("Hello"). Nothing reads the microphone or sends audio. Delete the file to turn it off.
import { signal } from "nsh";
import { stat } from "fs/promises";
import process from "process";
import { setDictationFactoryForTest } from "./dictation";
import type { Dictation, VoiceState } from "./dictation";

export function forcedRecordingDictation(): Dictation {
  const state = signal<VoiceState>({ phase: "recording", error: null, errorAction: null });
  return {
    state: () => state(), preview: () => (state().phase === "recording" ? { committed: "Hello", tentative: "" } : null), activity: () => 0, level: () => 0,
    async start() { state.set({ phase: "recording", error: null, errorAction: null }); },
    confirm() { state.set({ phase: "idle", error: null, errorAction: null }); },
    cancel() { state.set({ phase: "idle", error: null, errorAction: null }); },
  };
}

/** `primary-states` beside the bootstrap file: the composer shows every primary action state (PrimaryActionStates). */
export const showPrimaryActionStates = signal(false);

export async function installForcedRecordingIfFlagged(): Promise<void> {
  const flagDir = (() => { const bootstrap = process.env.T3GPUI_BOOTSTRAP_FILE; return bootstrap ? bootstrap.slice(0, bootstrap.lastIndexOf("/")) : null; })();
  if (flagDir) void stat(`${flagDir}/primary-states`).then(() => showPrimaryActionStates.set(true), () => undefined);
  const bootstrap = process.env.T3GPUI_BOOTSTRAP_FILE;
  if (!bootstrap) return;
  try { await stat(`${bootstrap.slice(0, bootstrap.lastIndexOf("/"))}/force-recording`); } catch { return; }
  setDictationFactoryForTest(() => forcedRecordingDictation());
}
