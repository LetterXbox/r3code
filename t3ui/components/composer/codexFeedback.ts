// The Codex /feedback command (client-runtime state/threadFeedback.ts): `/feedback [reason]` uploads the thread's
// Codex session to OpenAI through `provider.uploadFeedback`. The composer clears at once, a banner reports the
// upload, and a sent one offers "Copy ID".
import { Clipboard, signal } from "nsh";
import type { BannerItem } from "../banners/bannerTypes";
import { showToast } from "../toast";

export type CodexFeedbackSubmission = { id: string; command: string; createdAt: string } & (
  | { status: "uploading" | "interrupted" }
  | { status: "sent"; feedbackId: string }
  | { status: "failed"; errorMessage: string }
);

/** parseCodexFeedbackCommand: `/feedback` with an optional reason; anything else is not the command. */
export function parseCodexFeedbackCommand(text: string): { reason?: string } | null {
  const match = /^\/feedback(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (!match) return null;
  const reason = match[1]?.trim();
  return reason ? { reason } : {};
}

/** codexFeedbackNotice: the banner's title and description for a submission (null for an interrupted one). */
export function codexFeedbackNotice(submission: CodexFeedbackSubmission): { title: string; description: string | undefined } | null {
  switch (submission.status) {
    case "interrupted": return null;
    case "uploading": return { title: "Sending feedback to OpenAI...", description: undefined };
    case "sent": return { title: "Feedback sent to OpenAI", description: `Thread ID: ${submission.feedbackId}` };
    case "failed": return { title: "Could not send feedback to OpenAI", description: submission.errorMessage };
  }
}

/** submitCodexFeedback: reports uploading, clears the draft, uploads, then reports the outcome. */
export async function submitCodexFeedback(input: {
  submission: { id: string; command: string; createdAt: string };
  clearDraft: () => void;
  onUpdate: (submission: CodexFeedbackSubmission) => void;
  upload: () => Promise<{ feedbackId: string }>;
}): Promise<void> {
  input.onUpdate({ ...input.submission, status: "uploading" });
  input.clearDraft();
  try {
    const result = await input.upload();
    input.onUpdate({ ...input.submission, status: "sent", feedbackId: result.feedbackId });
  } catch (cause) {
    input.onUpdate({ ...input.submission, status: "failed", errorMessage: cause instanceof Error && cause.message ? cause.message : "An error occurred." });
  }
}

// ---- Per-thread state (the composer's feedbackSubmissionsByThreadKey and feedbackUploadsInFlightRef) ----

const submissionsByThread = signal<Record<string, CodexFeedbackSubmission[]>>({});
const inFlight = new Set<string>();

export const feedbackSubmissionsFor = (threadId: string): CodexFeedbackSubmission[] => submissionsByThread()[threadId] ?? [];
export const feedbackUploadInFlight = (threadId: string) => inFlight.has(threadId);

export function recordFeedbackSubmission(threadId: string, submission: CodexFeedbackSubmission): void {
  submissionsByThread.update((all) => {
    const existing = all[threadId] ?? [];
    const found = existing.some((entry) => entry.id === submission.id);
    return { ...all, [threadId]: found ? existing.map((entry) => (entry.id === submission.id ? submission : entry)) : [...existing, submission] };
  });
}
export function dismissFeedbackSubmission(threadId: string, submissionId: string): void {
  submissionsByThread.update((all) => ({ ...all, [threadId]: (all[threadId] ?? []).filter((entry) => entry.id !== submissionId) }));
}

/** Uploads one `/feedback` command for a thread; a second one while one is in flight is refused by the caller. */
export async function runCodexFeedback(input: {
  threadId: string; command: string; reason?: string; clearDraft: () => void;
  request: (method: string, payload: unknown) => Promise<unknown>;
}): Promise<void> {
  inFlight.add(input.threadId);
  try {
    await submitCodexFeedback({
      submission: { id: `message:${crypto.randomUUID()}`, command: input.command, createdAt: new Date().toISOString() },
      clearDraft: input.clearDraft,
      onUpdate: (submission) => recordFeedbackSubmission(input.threadId, submission),
      upload: async () => {
        const result = await input.request("provider.uploadFeedback", { threadId: input.threadId, ...(input.reason ? { reason: input.reason } : {}) });
        const feedbackId = typeof (result as { feedbackId?: unknown } | null)?.feedbackId === "string" ? (result as { feedbackId: string }).feedbackId : "";
        if (!feedbackId.trim()) throw new Error("The server did not return a feedback ID.");
        return { feedbackId };
      },
    });
  } finally {
    inFlight.delete(input.threadId);
  }
}

/** feedbackBannerItem (ComposerFeedback.tsx): the composer notice for one submission; "Copy ID" once sent, dismissable once settled. */
export function feedbackBannerItem(submission: CodexFeedbackSubmission, onDismiss: () => void, copy: (text: string) => Promise<unknown> = (text) => Clipboard.writeText(text)): BannerItem | null {
  const notice = codexFeedbackNotice(submission);
  if (!notice) return null;
  return {
    id: `feedback:${submission.id}`,
    variant: submission.status === "failed" ? "error" : submission.status === "sent" ? "success" : "info",
    icon: "message-circle",
    title: notice.title,
    ...(notice.description !== undefined ? { description: notice.description } : {}),
    actions: submission.status === "sent" ? [{
      id: "copy-id", label: "Copy ID", tone: "button",
      run: () => {
        const feedbackId = submission.feedbackId;
        void copy(feedbackId).catch((cause: unknown) => showToast({ type: "error", title: "Could not copy thread ID", description: cause instanceof Error && cause.message ? cause.message : "An error occurred." }));
      },
    }] : [],
    ...(submission.status !== "uploading" ? { dismissLabel: "Dismiss feedback notice", onDismiss } : {}),
  };
}
