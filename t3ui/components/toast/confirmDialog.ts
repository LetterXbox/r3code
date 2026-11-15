// The shared confirmation (apps/web/src/confirmDialog.ts and ConfirmDialogHost.tsx): `confirm(message, { variant })`
// resolves true on Confirm and false on Cancel, Escape or a press on the backdrop. One shows at a time; the rest queue.
// Without a mounted host the promise resolves false at once (the web's `requestConfirmDialog` answers undefined).
import { signal } from "nsh";

export type ConfirmDialogVariant = "default" | "destructive";
export interface ConfirmDialogOptions { variant?: ConfirmDialogVariant; /** The confirm button's label ("Merge"); "Confirm" by default. */ confirmLabel?: string }

interface Pending { message: string; variant: ConfirmDialogVariant; confirmLabel?: string; resolve: (confirmed: boolean) => void }
export type ConfirmDialogState =
  | { status: "idle" }
  | { status: "confirming"; message: string; variant: ConfirmDialogVariant; confirmLabel?: string };

const state = signal<ConfirmDialogState>({ status: "idle" });
let active: Pending | null = null;
let queued: Pending[] = [];
let hosts = 0;

export const confirmDialogState = () => state();
/** True while a confirmation shows or waits: shortcuts and Escape leave the app alone. */
export const confirmDialogOpen = () => state().status !== "idle";

/** The host registers while mounted, so `confirm` knows a dialog can appear; the last one leaving cancels what is pending. */
export function attachConfirmDialogHost(): () => void {
  hosts += 1;
  return () => {
    hosts -= 1;
    if (hosts > 0) return;
    hosts = 0;
    active?.resolve(false);
    for (const pending of queued) pending.resolve(false);
    active = null;
    queued = [];
    state.set({ status: "idle" });
  };
}

function show(pending: Pending) {
  active = pending;
  state.set({ status: "confirming", message: pending.message, variant: pending.variant, ...(pending.confirmLabel ? { confirmLabel: pending.confirmLabel } : {}) });
}

/** Whether a confirmation can be shown at all (a host is mounted). Without one, callers proceed as the web does without its dialog API. */
export const confirmDialogAvailable = () => hosts > 0;

/** Asks the user to confirm `message`. */
export function confirm(message: string, options?: ConfirmDialogOptions): Promise<boolean> {
  if (hosts === 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const pending: Pending = { message, variant: options?.variant ?? "default", ...(options?.confirmLabel ? { confirmLabel: options.confirmLabel } : {}), resolve };
    if (active) queued.push(pending);
    else show(pending);
  });
}

/** Cancel / Confirm / Escape / backdrop. The next queued confirmation shows right after. */
export function respondToConfirmDialog(confirmed: boolean) {
  const current = active;
  if (!current) return;
  active = null;
  const next = queued.shift();
  if (next) show(next);
  else state.set({ status: "idle" });
  current.resolve(confirmed);
}

export function resetConfirmDialogForTests() {
  active?.resolve(false);
  for (const pending of queued) pending.resolve(false);
  active = null;
  queued = [];
  hosts = 0;
  state.set({ status: "idle" });
}

export interface ConfirmationCopy { title: string; description: string | null }

/** ConfirmDialogHost's resolveConfirmDialogCopy: the question is the title, the rest of the message the description. */
export function resolveConfirmDialogCopy(message: string): ConfirmationCopy {
  const normalized = message.trim();
  const lines = normalized.split("\n");
  const questionLine = lines.findIndex((line) => line.trim().endsWith("?"));
  if (questionLine >= 0) {
    const description = lines.filter((_, index) => index !== questionLine).join("\n").trim();
    return { title: lines[questionLine]!.trim(), description: description || null };
  }
  const questionMark = normalized.indexOf("?");
  if (questionMark >= 0) {
    return { title: normalized.slice(0, questionMark + 1).trim(), description: normalized.slice(questionMark + 1).trim() || null };
  }
  return { title: "Confirm action", description: normalized || "This action requires your confirmation." };
}
