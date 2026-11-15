// Port of apps/desktop/src/preview/RecordingInput.ts: the key label shown by the recording cursor's badge, and the
// check that keeps a sensitive field's keys out of it. previewRecordingPage.ts (the in-page script, shipped as text,
// previewRecordingPage.generated.ts) carries its own copy of this logic -- it must be plain JavaScript with no
// imports -- so recordingInputParity.test.ts checks the two copies answer the same for the same inputs.
export interface RecordingInputOptions {
  readonly showKeyPresses: boolean;
  readonly showMousePresses: boolean;
}

export const DEFAULT_RECORDING_INPUT_OPTIONS: RecordingInputOptions = {
  showKeyPresses: false,
  showMousePresses: false,
};

export interface RecordingKeyPress {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

export function recordingKeyLabel(input: RecordingKeyPress, isMac: boolean): string | null {
  if (["Dead", "Process", "Unidentified", ""].includes(input.key)) return null;
  const modifiers = [
    input.ctrlKey || input.key === "Control" ? (isMac ? "⌃" : "Ctrl") : null,
    input.altKey || input.key === "Alt" ? (isMac ? "⌥" : "Alt") : null,
    input.shiftKey || input.key === "Shift" ? (isMac ? "⇧" : "Shift") : null,
    input.metaKey || input.key === "Meta" ? (isMac ? "⌘" : "Win") : null,
  ].filter((value) => value !== null);
  const labels: Record<string, string> = {
    Enter: "↵",
    Tab: "⇥",
    Backspace: "⌫",
    Delete: "⌦",
    Escape: "Esc",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    " ": "Space",
    Space: "Space",
  };
  if (!["Control", "Alt", "Shift", "Meta"].includes(input.key)) {
    modifiers.push(labels[input.key] ?? (input.key.length === 1 ? input.key.toUpperCase() : input.key));
  }
  return modifiers.join(isMac ? "" : " + ");
}

/** The page's `document`, or a stand-in of the same shape for tests (this module runs on the host side, not in the
 * page -- previewRecordingPage.ts carries its own, plain-JS copy of this check). */
export interface SensitiveDocumentElement {
  readonly tagName: string;
  readonly shadowRoot?: { readonly activeElement?: SensitiveDocumentElement | null } | null;
  getAttribute?(name: string): string | null;
}
export interface SensitiveDocument {
  readonly activeElement: SensitiveDocumentElement | null;
}

/** Unknown iframe or closed-shadow focus is excluded because its field type cannot be checked. */
export function recordingKeysAreSensitive(document: SensitiveDocument): boolean {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return (
    element?.tagName === "IFRAME" ||
    element?.tagName.includes("-") === true ||
    element?.getAttribute?.("type")?.toLowerCase() === "password"
  );
}
