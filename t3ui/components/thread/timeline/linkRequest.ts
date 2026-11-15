// Ported from packages/client-runtime/src/linkRequest.ts: what a `link_request` turn item card shows and the
// `peerLinks.answerRequest` payload (PeerLinkRequestAnswerInput) it sends.
import { runtimeModeConfig } from "../../composer/runtimeModeConfig";

export type LinkAccess = "read-only" | "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export const LINK_ACCESS_OPTIONS: readonly LinkAccess[] = ["read-only", "approval-required", "auto-accept-edits", "auto", "full-access"];

/** ConnectAgentSurface.tsx accessConfig. */
export const accessConfig: Record<LinkAccess, { label: string; description: string }> = {
  "read-only": { label: "Read only", description: "Read projects and threads. Cannot start, message or change anything." },
  "approval-required": runtimeModeConfig["approval-required"],
  "auto-accept-edits": runtimeModeConfig["auto-accept-edits"],
  auto: runtimeModeConfig.auto,
  "full-access": runtimeModeConfig["full-access"],
};
export const accessLabel = (access: LinkAccess) => accessConfig[access].label;

export type LinkRequestItem = {
  id: string; threadId: string; url?: string; reason: string; environmentId?: string; label?: string; hint?: string;
  requestedAccess?: LinkAccess; linkStatus: "pending" | "linked" | "declined" | "cancelled" | "failed";
  linkedEnvironmentId?: string; linkedLabel?: string; linkedAccess?: LinkAccess; failure?: string;
};

const ACCESS = new Set<string>(LINK_ACCESS_OPTIONS);
const STATUS = new Set(["pending", "linked", "declined", "cancelled", "failed"]);
const str = (value: unknown) => (typeof value === "string" ? value : undefined);

/** A `link_request` turn item as the card reads it, or null. */
export function linkRequestFromTurnItem(value: unknown): LinkRequestItem | null {
  const item = value as Record<string, unknown> | null;
  if (!item || item.type !== "link_request" || typeof item.id !== "string" || typeof item.threadId !== "string" || !STATUS.has(String(item.linkStatus))) return null;
  const access = (key: string) => (ACCESS.has(String(item[key])) ? { [key]: item[key] as LinkAccess } : {});
  const optional = (key: string) => (str(item[key]) !== undefined ? { [key]: str(item[key]) } : {});
  return {
    id: item.id, threadId: item.threadId, reason: str(item.reason) ?? "", linkStatus: item.linkStatus as LinkRequestItem["linkStatus"],
    ...optional("url"), ...optional("environmentId"), ...optional("label"), ...optional("hint"), ...optional("linkedEnvironmentId"),
    ...optional("linkedLabel"), ...optional("failure"), ...access("requestedAccess"), ...access("linkedAccess"),
  };
}

export const linkRequestDefaultAccess = (item: Pick<LinkRequestItem, "requestedAccess">): LinkAccess => item.requestedAccess ?? "approval-required";
export const linkRequestTargetName = (item: Pick<LinkRequestItem, "label" | "url">): string => item.label?.trim() || item.url || "a machine";
/** Whether the agent left the machine for the user to pick. */
export const picksMachine = (item: Pick<LinkRequestItem, "environmentId" | "url">) => item.environmentId === undefined && item.url === undefined;

export type LinkRequestDisplay =
  | { kind: "pending" }
  | { kind: "pending-elsewhere"; label: string }
  | { kind: "answered"; outcome: "linked" | "declined" | "ended" | "failed"; label: string };

export function linkRequestDisplay(item: LinkRequestItem, visibility: "local" | "inherited" | "synthetic" = "local"): LinkRequestDisplay {
  switch (item.linkStatus) {
    case "pending": return visibility === "local" ? { kind: "pending" } : { kind: "pending-elsewhere", label: "Waiting for an answer in the original thread" };
    case "linked": return { kind: "answered", outcome: "linked", label: `Linked ${item.linkedLabel ?? linkRequestTargetName(item)}${item.linkedAccess === undefined ? "" : ` · ${accessLabel(item.linkedAccess)}`}` };
    case "declined": return { kind: "answered", outcome: "declined", label: "Declined" };
    case "failed": return { kind: "answered", outcome: "failed", label: `Could not link: ${item.failure ?? "the other environment refused"}` };
    case "cancelled": return { kind: "answered", outcome: "ended", label: "Request ended" };
  }
}

export type LinkRequestAnswer =
  | { type: "link"; target: { environmentId: string; label: string; urls: readonly string[] } | { url: string }; access: LinkAccess; pairingCode: string }
  | { type: "use-existing"; environmentId: string }
  | { type: "decline" };

/** A link with a blank code or address returns null, since the server rejects it. */
export function linkRequestAnswerInput(item: Pick<LinkRequestItem, "id" | "threadId">, answer: LinkRequestAnswer): Record<string, unknown> | null {
  const base = { threadId: item.threadId, turnItemId: item.id };
  if (answer.type !== "link") return { ...base, answer };
  const pairingCode = answer.pairingCode.trim();
  if (pairingCode.length === 0) return null;
  const { target } = answer;
  if ("url" in target) {
    const url = target.url.trim();
    return url.length === 0 ? null : { ...base, answer: { type: "link", urls: [url], access: answer.access, pairingCode } };
  }
  if (target.urls.length === 0) return null;
  return { ...base, answer: { type: "link", environmentId: target.environmentId, label: target.label, urls: [...target.urls], access: answer.access, pairingCode } };
}

const USER_FACING_FAILURE_TAGS = new Set(["PeerLinkRequestError", "EnvironmentAuthorizationError", "PeerPairingCodeError"]);

/** Only known errors pass their message through, so the pairing code can never surface in the UI. */
export function linkRequestFailureMessage(failure: unknown): string {
  const value = failure as Record<string, unknown> | null;
  // A failed RPC here is a RequestFailure carrying the contract error's tag as `tag`; a decoded error carries `_tag`.
  const tag = value && typeof value === "object" ? (value._tag ?? value.tag) : undefined;
  if (value && typeof value === "object" && typeof tag === "string" && USER_FACING_FAILURE_TAGS.has(tag) && typeof value.message === "string" && value.message.trim().length > 0 && value.message !== "Request failed") return value.message;
  return "Could not answer the request. Try again.";
}
