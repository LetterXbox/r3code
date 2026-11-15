// The editable source of a file (FilePreviewPanel.tsx EditableFileSurface): the text is edited in place and written back by the
// file's save session after a pause (fileSave.ts), and again when the tab goes away. The web app edits in a code editor with
// syntax colours and a line gutter; this is a plain multiline field in the code font, which keeps the keyboard in an ordinary
// input (a focused field that is removed leaves no key bindings behind, unlike the composer's rich editor).
import { effect } from "nsh";
import type { InputRef } from "nsh";
import { Input } from "nsh/base";
import { codeTextStyle } from "../../typography";
import { noteUnsavedEdit, fileSaveSessions } from "./fileSaveRuntime";

/** The offset of the start of one-based line `line` in `text` (clamped); the caret goes there when a file is opened at a line. */
export function lineStartOffset(text: string, line: number | undefined): number | undefined {
  if (line === undefined || !Number.isFinite(line) || line < 2) return undefined;
  let offset = 0;
  for (let current = 1; current < Math.floor(line); current++) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return offset;
    offset = next + 1;
  }
  return offset;
}

export interface FileEditorProps {
  cwd: string;
  relativePath: string;
  /** The text shown; the field is controlled by it. */
  value: () => string;
  onInput: (text: string) => void;
  line?: number | undefined;
  onPendingChange?: ((relativePath: string, pending: boolean) => void) | undefined;
}

export function FileEditor(props: FileEditorProps) {
  // Holds the file's save session while the editor is mounted; the last one to leave flushes what is pending.
  effect(() => fileSaveSessions.acquire({ cwd: props.cwd, relativePath: props.relativePath }, (path, pending) => props.onPendingChange?.(path, pending)));
  const caret = lineStartOffset(props.value(), props.line);
  // installFileEditorDismissal: Escape in the editor drops its selection and lets go of the keyboard; the edits stay
  // (unsaved ones keep their marker and save as before). A press outside blurs the field natively.
  let inputNode: InputRef | null = null;
  return (
    <Input
      ref={(node: InputRef) => { inputNode = node; }}
      onKeyPress={(event) => { if (event.key === "Escape" && inputNode) { inputNode.setSelection(0); inputNode.blur(); } }}
      multiline
      accessibilityLabel={`Edit ${props.relativePath}`}
      testID="File editor"
      value={props.value()}
      autoCapitalize="none"
      autoCorrect={false}
      {...(caret === undefined ? {} : { selectedRange: { start: caret } })}
      style={codeTextStyle()}
      class="min-h-0 flex-1 rounded-none border-0 bg-transparent px-3 py-2 text-foreground"
      onChange={(event) => {
        props.onInput(event.value);
        noteUnsavedEdit({ cwd: props.cwd, relativePath: props.relativePath }, event.value);
      }}
    />
  );
}
