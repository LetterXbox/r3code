// The composer's dictation pipeline (destination, recorder, transcriber, language and fillers, setup), shared with
// other text fields that dictate the same way: the preview annotation editor (PreviewAnnotationSpeech.tsx).
import type { DictationDeps } from "./dictation";

export type SharedDictationDeps = Omit<DictationDeps, "prompt" | "caret" | "insert">;

let shared: SharedDictationDeps | null = null;

export function registerSharedDictation(deps: SharedDictationDeps): void { shared = deps; }
export function sharedDictationDeps(): SharedDictationDeps | null { return shared; }
