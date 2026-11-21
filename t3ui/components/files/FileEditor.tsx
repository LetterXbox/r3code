// The editable source of a file (FilePreviewPanel.tsx EditableFileSurface): the text is edited in place and written back by the
// file's save session after a pause (fileSave.ts), and again when the tab goes away. The web app edits in a code editor with
// syntax colours and a line gutter; this is a plain multiline field in the code font, which keeps the keyboard in an ordinary
// input (a focused field that is removed leaves no key bindings behind, unlike the composer's rich editor).
import { effect } from "nsh";
import { Editor } from "nsh/base";
import type { EditorRef } from "nsh/base";
import { codeTextStyle } from "../../typography";
import { scaledFor } from "../../shell/surfaceZoom";
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
  // R3: a real code editor (nsh/base Editor): line numbers, syntax colours by file name, folding, find. Font and size
  // follow the code font setting, the app zoom and the files surface zoom (Cmd+/- over the file).
  const line = props.line;
  return (
    <Editor
      ref={(node: EditorRef) => { if (line !== undefined && Number.isFinite(line) && line >= 2) node.goToLine(Math.floor(line) - 1); }}
      accessibilityLabel={`Edit ${props.relativePath}`}
      testID="File editor"
      value={props.value()}
      language={props.relativePath.split("/").pop() ?? null}
      fontFamily={codeTextStyle().fontFamily}
      fontSize={scaledFor("files", codeTextStyle().fontSize)}
      lineHeight={scaledFor("files", 20)}
      class="min-h-0 flex-1 bg-transparent"
      onChange={(event) => {
        props.onInput(event.value);
        noteUnsavedEdit({ cwd: props.cwd, relativePath: props.relativePath }, event.value);
      }}
    />
  );
}
