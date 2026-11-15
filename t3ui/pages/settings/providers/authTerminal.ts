// Pure helpers for the sign-in terminal (ProviderAuthTerminal.tsx): which part of the streamed
// output the renderer still needs, and how renderer messages become provider.auth responses.
import type { ProviderAuthResponse } from "../../../backend/providerSetup";

export type TerminalResponse = Extract<ProviderAuthResponse, { type: "terminal" }>;
export type TerminalWrite = { kind: "none" } | { kind: "append"; data: string } | { kind: "reset"; data: string };

/** The reference's incremental write: the new tail when the offset advanced, a full replay when it jumped or rewound. */
export function terminalWrite(output: string, outputOffset: number | undefined, written: number): { write: TerminalWrite; offset: number } {
  const offset = outputOffset ?? output.length;
  const delta = offset - written;
  if (delta > 0 && delta <= output.length) return { write: { kind: "append", data: output.slice(-delta) }, offset };
  if (delta !== 0) return { write: { kind: "reset", data: output }, offset };
  return { write: { kind: "none" }, offset };
}

/** A renderer message (input, resize, ready) as the response the server expects; null for anything else. */
export function terminalResponseFor(message: Record<string, unknown>): TerminalResponse | null {
  if (message.type === "input" && typeof message.data === "string" && message.data.length > 0) return { type: "terminal", data: message.data };
  if ((message.type === "resize" || message.type === "ready") && typeof message.cols === "number" && typeof message.rows === "number"
    && Number.isFinite(message.cols) && Number.isFinite(message.rows)) {
    return { type: "terminal", data: "", size: { cols: Math.max(1, Math.min(500, Math.floor(message.cols))), rows: Math.max(1, Math.min(200, Math.floor(message.rows))) } };
  }
  return null;
}
