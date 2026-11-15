// PreviewAnnotationSpeech.tsx: the annotation editor lives inside the page, which only forwards gestures and mirrors
// state. Recording, consent and transcription stay in the app, on the composer's dictation pipeline
// (composer/dictation.ts with the composer's destination and recorder, composer/sharedDictation.ts); the transcript is
// written into the page's comment draft, not the composer.
import { effect, signal, untracked } from "nsh";
import { makeDictation, type Dictation } from "../composer/dictation";
import { resolveSpeechPresentation } from "../composer/ComposerSpeechButton";
import { sharedDictationDeps, type SharedDictationDeps } from "../composer/sharedDictation";
import { showToast } from "../toast";
import { activeRules } from "../../commands/registry";
import { effectiveShortcut, shortcutLabelFor } from "../../commands/shortcutLabel";

export interface PickVoiceEvent { action: "start" | "stop" | "cancel"; text: string; cursor: number; selectionEnd: number | null }

/** The page's `{ t3: "pick", voice }` message, or null. */
export function readPickVoice(data: string): PickVoiceEvent | null {
  let m: { t3?: unknown; voice?: unknown; text?: unknown; cursor?: unknown; selectionEnd?: unknown };
  try { m = JSON.parse(data); } catch { return null; }
  if (m?.t3 !== "pick" || (m.voice !== "start" && m.voice !== "stop" && m.voice !== "cancel")) return null;
  const text = typeof m.text === "string" ? m.text : "";
  const cursor = typeof m.cursor === "number" ? Math.max(0, Math.min(m.cursor, text.length)) : text.length;
  return { action: m.voice, text, cursor, selectionEnd: typeof m.selectionEnd === "number" ? m.selectionEnd : null };
}

/** The script that mirrors a voice state into the page's editor. */
export const voiceStateScript = (state: Record<string, unknown>): string =>
  `window.__t3pick && window.__t3pick.voiceState && window.__t3pick.voiceState(${JSON.stringify(state).replace(/</g, "\\u003c")});true;`;

/**
 * The browser tab's annotation dictation: made with the tab (its effect belongs to the tab); the pipeline is the
 * composer's, taken when dictation first starts. Gestures from the page drive it; its state and transcript go back.
 */
export function createAnnotationVoice(inject: (script: string) => void, shared: () => SharedDictationDeps | null = sharedDictationDeps): { handle: (event: PickVoiceEvent) => void; available: () => boolean; cancel: () => void } {
  const draft = { text: "", cursor: 0 };
  const current = signal<Dictation | null>(null);
  const publish = (dictation: Dictation, extra: Record<string, unknown> = {}) => {
    try {
      const state = dictation.state();
      const preview = dictation.preview();
      inject(voiceStateScript({ available: true, level: dictation.level?.() ?? 0, phase: state.phase, status: resolveSpeechPresentation({ phase: state.phase, ...(state.error ? { error: state.error } : {}) }).status, preview: preview ? preview.committed + preview.tentative : null, ...extra }));
    } catch (error) {
      dictation.cancel();
      showToast({ type: "error", title: "Could not update annotation voice input", description: error instanceof Error ? error.message : String(error) });
    }
  };
  effect(() => { const dictation = current(); if (!dictation) return; dictation.state(); dictation.preview(); dictation.activity(); untracked(() => publish(dictation)); });
  const ensure = (): Dictation | null => {
    const existing = untracked(current);
    if (existing) return existing;
    const deps = shared();
    if (!deps) return null;
    let made: Dictation | null = null;
    made = makeDictation({
      ...deps,
      prompt: () => draft.text,
      caret: () => draft.cursor,
      insert: (text, caret) => { draft.text = text; draft.cursor = caret; if (made) publish(made, { text, cursor: caret }); },
    });
    current.set(made);
    return made;
  };
  return {
    available: () => shared() !== null,
    handle: (event) => {
      draft.text = event.text; draft.cursor = event.cursor;
      const dictation = event.action === "start" ? ensure() : untracked(current);
      if (!dictation) return;
      if (event.action === "start") void dictation.start();
      else if (event.action === "stop") dictation.confirm();
      else dictation.cancel();
    },
    cancel: () => untracked(current)?.cancel(),
  };
}

/** effectiveShortcutsForCommand(keybindings, "composer.dictation", { previewFocus, previewOpen, editableFocus }): the chords
 * the page's editor answers, and the label its mic button shows. */
export function dictationShortcuts(): { keys: string[]; label: string | null } {
  const context = { previewFocus: true, previewOpen: true, editableFocus: true, composerFocus: false, terminalFocus: false };
  const key = effectiveShortcut(activeRules(), "composer.dictation", context);
  return { keys: key ? [key] : [], label: shortcutLabelFor(activeRules(), "composer.dictation", context) };
}
