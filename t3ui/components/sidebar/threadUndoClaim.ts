// showThreadUndoNotice.ts:60-135: a fresh undo notice owns mod+z even inside a text field, until the user presses another
// key or edits text; then mod+z is the field's own undo again. The composer asks here (no import of the thread actions).
let claimed = false;
let runner: (() => boolean) | null = null;

/** threadActions registers how to undo the notice's actions (returns false when there is no notice). */
export function setThreadUndoRunner(run: (() => boolean) | null) { runner = run; }
export function claimThreadUndoShortcut() { claimed = true; }
/** releaseThreadUndoShortcut: any other key or a text edit hands mod+z back to the field. */
export function releaseThreadUndoShortcut() { claimed = false; }
/** mod+z in a text field: true when the notice took it. */
export function takeThreadUndoShortcut(): boolean {
  if (!claimed || !runner) return false;
  return runner();
}
