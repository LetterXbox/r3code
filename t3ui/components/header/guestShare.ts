// GuestShareControls.tsx's rules: the create dialog's state, the copy of its two phases, the availability of "Share with
// guest" (guestShareAvailability.ts) and the two commands that resolve a waiting guest message (client-runtime
// operations/commands.ts resolveGuestMessage). Pure over the request seam, so the tests drive it without a server.
import { signal } from "nsh";

export type GuestShareCreateState =
  | { status: "idle" }
  | { status: "creating" }
  | { status: "created"; url: string }
  | { status: "failed"; message: string };

export const GUEST_SHARE_DIALOG_TITLE = "Share with guest";
export const GUEST_SHARE_DIALOG_DESCRIPTION = "The guest sees the thread as you do, including command output and the agent's reasoning. Each message they send waits for you.";

/** The panel text under the description, before a link exists. */
export const guestShareCreateNote = (hasActiveShare: boolean) => (hasActiveShare ? "A new link ends the current one." : "The link works once and expires in 24 hours.");

/** The dialog's thread: set by "Share with guest" in the thread menu and the palette; null while it is closed. */
const dialogThread = signal<string | null>(null);
export const guestShareDialogThreadId = () => dialogThread();
export const openGuestShareDialog = (threadId: string) => dialogThread.set(threadId);
export const closeGuestShareDialog = () => dialogThread.set(null);

/**
 * Whether this environment offers "Share with guest": its Guest links beta is on (`settings.guestSharingEnabled`), and
 * a managed policy has not turned off T3 Connect, which guests arrive through.
 */
export function canShareWithGuest(input: { settings: Record<string, unknown> | null; managedPolicy: Record<string, unknown> | null; connected: boolean }): boolean {
  if (!input.connected || input.settings?.guestSharingEnabled !== true) return false;
  const capabilities = input.managedPolicy && typeof input.managedPolicy.capabilities === "object" && input.managedPolicy.capabilities !== null ? (input.managedPolicy.capabilities as Record<string, unknown>) : null;
  return capabilities?.connect !== false;
}

type Request = (method: string, payload: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;

/** `guestShare.create`: resolves with the link the guest opens. */
export async function createGuestShare(threadId: string, request: Request): Promise<string> {
  const result = await request("guestShare.create", { threadId });
  const url = typeof result === "object" && result !== null ? (result as Record<string, unknown>).url : null;
  if (typeof url !== "string" || url === "") throw new Error("Could not create a guest link.");
  return url;
}

/** `thread.guest-share.close`: ends the share. */
export function closeGuestShare(threadId: string, request: Request): Promise<unknown> {
  return request("orchestration.dispatchCommand", { type: "thread.guest-share.close", commandId: `command:${crypto.randomUUID()}`, threadId });
}

/**
 * Sending runs the guest's text as a normal queued turn (the server supplies the text); dismissing deletes the message.
 */
export function resolveGuestMessage(input: { threadId: string; guestMessageId: string; decision: "send" | "dismiss" }, request: Request): Promise<unknown> {
  const commandId = `command:${crypto.randomUUID()}`;
  if (input.decision === "dismiss") return request("orchestration.dispatchCommand", { type: "thread.guest-message.dismiss", commandId, threadId: input.threadId, guestMessageId: input.guestMessageId });
  return request("orchestration.dispatchCommand", {
    type: "message.dispatch", commandId, threadId: input.threadId, messageId: commandId, guestMessageId: input.guestMessageId,
    text: "", attachments: [], dispatchMode: { type: "queue_after_active" }, createdBy: "user", creationSource: "web",
  });
}

export const guestPendingLabel = (count: number) => `${count} guest message${count === 1 ? "" : "s"} waiting`;
