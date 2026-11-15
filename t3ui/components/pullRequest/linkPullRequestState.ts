// LinkPullRequestDialog.tsx's state and rules: the dialog is hosted in the chat so it survives the
// palette closing, and resolves a pasted URL or a bare number into a thread pull request key.
import { signal } from "nsh";
import { requestBackend, threadById } from "../../store";

export interface ResolvedPullRequestLink { host: string; repository: string; number: number; url: string }
export type LinkResolution = { link: ResolvedPullRequestLink } | { error: string } | null;

const NUMBER = /^#?(\d+)$/;

/** A change request URL on any host: github /pull/N, gitlab /-/merge_requests/N, gitea and forgejo /pulls/N. */
export function parsePullRequestUrl(input: string): ResolvedPullRequestLink | null {
  const match = /^https?:\/\/([^/\s]+)\/(.+?)\/(?:-\/merge_requests|pulls?|merge_requests)\/(\d+)(?:[/?#].*)?$/u.exec(input.trim());
  if (!match) return null;
  const number = Number(match[3]);
  const repository = match[2]!.replace(/\/+$/u, "");
  if (!Number.isSafeInteger(number) || number < 1 || !repository.includes("/")) return null;
  return { host: match[1]!.toLowerCase(), repository, number, url: input.trim().replace(/[?#].*$/u, "").replace(/\/+$/u, "") };
}

/**
 * resolveLinkPullRequestInput: a URL links as it is; a bare 123 or #123 needs the thread project's
 * repository, which this build does not know, so it says so the way the web does without one.
 */
export function resolveLinkPullRequestInput(
  reference: string,
  project: { host: string; repository: string; webUrl: (number: number) => string } | null = null,
): LinkResolution {
  const trimmed = reference.trim();
  const url = parsePullRequestUrl(trimmed);
  if (url) return { link: url };
  const number = NUMBER.exec(trimmed)?.[1];
  if (number === undefined) return null;
  const value = Number(number);
  if (!Number.isSafeInteger(value) || value < 1) return null;
  if (project === null) return { error: "Paste the full pull request URL; this thread has no repository to resolve the number against." };
  return { link: { host: project.host, repository: project.repository, number: value, url: project.webUrl(value) } };
}

/** The message under the field once the user has typed, or null. */
export function linkValidation(reference: string, resolved: LinkResolution, dirty: boolean): string | null {
  if (!dirty) return null;
  if (reference.trim().length === 0) return "Paste a pull request URL or enter 123 / #123.";
  if (resolved === null) return "Use a pull request URL, 123, or #123.";
  return "error" in resolved ? resolved.error : null;
}

const target = signal<string | null>(null);
const reference = signal("");
const dirty = signal(false);
const submitError = signal<string | null>(null);
const pending = signal(false);

export const linkDialogThread = () => target();
export const linkDialogReference = () => reference();
export const linkDialogDirty = () => dirty();
export const linkDialogError = () => submitError();
export const linkDialogPending = () => pending();
export const linkDialogResolved = (): LinkResolution => resolveLinkPullRequestInput(reference());

export function openLinkPullRequestDialog(threadId: string): void {
  reference.set("");
  dirty.set(false);
  submitError.set(null);
  pending.set(false);
  target.set(threadId);
}

export function setLinkDialogReference(text: string): void {
  dirty.set(true);
  reference.set(text);
}

export function closeLinkDialog(): void {
  if (pending()) return;
  target.set(null);
}

/** thread.pull-request.link with source "manual". Closes the dialog on success. */
export async function submitLinkDialog(): Promise<void> {
  dirty.set(true);
  const threadId = target();
  const resolved = linkDialogResolved();
  if (threadId === null || resolved === null || "error" in resolved) return;
  submitError.set(null);
  pending.set(true);
  try {
    if (!threadById(threadId)) throw new Error("The thread is no longer available.");
    await requestBackend("orchestration.dispatchCommand", {
      type: "thread.pull-request.link", commandId: `cmd:${crypto.randomUUID()}`, threadId,
      host: resolved.link.host, repository: resolved.link.repository, number: resolved.link.number, url: resolved.link.url, source: "manual",
    });
    pending.set(false);
    target.set(null);
  } catch (error) {
    pending.set(false);
    submitError.set(error instanceof Error && error.message ? error.message : "Could not link the pull request.");
  }
}
