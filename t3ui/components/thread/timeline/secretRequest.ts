// packages/client-runtime secretRequest.ts and contracts secretRequest.ts, for the native card: how a `secret_request` turn item reads
// (privacy note, link, display), the `secrets.answerRequest` payload, and which failures may show their message.
export interface SecretRequestField {
  name: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
}

export interface SecretRequestInput {
  key: string;
  label: string;
  placeholder: string;
  secret: boolean;
}

export type SecretRequestFields = {
  threadId: string;
  label: string;
  reason: string;
  url?: string;
  placeholder?: string;
  fields?: SecretRequestField[];
  delivery?: "file";
  /** OrchestrationV2SecretRequestStatus. */
  status: "pending" | "saved" | "declined" | "cancelled";
  /** The projected row's visibility: a request inherited from another thread (a fork) is answered where it was asked. */
  visibility?: "local" | "inherited" | "synthetic";
};

export const SECRET_REQUEST_DEFAULT_PLACEHOLDER = "Paste the secret";

/** A `file` request lets the agent's commands read the value, so its card must not promise more. */
export const secretRequestPrivacyNote = (request: Pick<SecretRequestFields, "delivery" | "fields">) =>
  request.delivery !== "file"
    ? "Stored securely, never shown to the agent"
    : request.fields === undefined
      ? "Kept out of chat, in a private file this agent's commands can read for 24 hours"
      : "Kept out of chat, in private files this agent's commands can read for 24 hours";

export function secretRequestInputs(item: Pick<SecretRequestFields, "label" | "placeholder" | "fields">): SecretRequestInput[] {
  if (item.fields === undefined) {
    return [{ key: "", label: item.label, placeholder: item.placeholder ?? SECRET_REQUEST_DEFAULT_PLACEHOLDER, secret: true }];
  }
  return item.fields.map((field) => ({
    key: field.name,
    label: field.label,
    placeholder: field.placeholder ?? "",
    secret: field.secret !== false,
  }));
}

export const secretRequestValue = (values: Readonly<Record<string, string>>, key: string): string =>
  Object.hasOwn(values, key) ? (values[key] ?? "") : "";

/** The http(s) page a secret card may open, or null for anything else. */
export function secretRequestPageUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.host !== "" ? url : null;
  } catch { return null; }
}

// Backticks, <angle brackets> and markdown link targets (balanced parentheses allowed) keep their exact text; a bare link drops trailing sentence punctuation.
const REASON_LINK = /`(https?:\/\/[^`\s]+)`|<(https?:\/\/[^>\s]+)>|\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\)|(https?:\/\/[^\s<>"'`[\]]+)/giu;

function trimPunctuation(link: string): string {
  let end = link.length;
  while (end > 0 && ".,;:!?)".includes(link[end - 1]!)) {
    const kept = link.slice(0, end);
    if (link[end - 1] === ")" && kept.split("(").length > kept.split(")").length - 1) break;
    end -= 1;
  }
  return link.slice(0, end);
}

/** Drops a closing `*` or `_` run only when the same run opened emphasis before the link and is still open. */
function trimEmphasis(link: string, before: string) {
  const run = /(\*{1,3}|_{1,3})$/u.exec(link)?.[1];
  if (run === undefined) return link;
  const escaped = run.replaceAll("*", "\\*");
  const opener = [...before.matchAll(new RegExp(`(?:^|[\\s(*_])${escaped}(?=\\S|$)`, "gu"))].at(-1);
  if (opener === undefined) return link;
  const closed = new RegExp(`\\S${escaped}(?:[\\s.,;:!?)]|$)`, "u").test(before.slice(opener.index + opener[0].length));
  return closed ? link : trimPunctuation(link.slice(0, -run.length));
}

/** The one distinct http(s) link in `reason`, for agents that put it there instead of in `url`. */
function reasonLink(reason: string): string | undefined {
  const raw = Array.from(reason.matchAll(REASON_LINK), (match) => {
    const [, ticked, angled, target, bare] = match;
    if (bare === undefined) return ticked ?? angled ?? target ?? "";
    const before = reason.slice(0, match.index);
    let link = trimPunctuation(bare);
    for (let next = trimEmphasis(link, before); next !== link; next = trimEmphasis(link, before)) link = next;
    return link;
  });
  const links = new Set(raw.map((link) => secretRequestPageUrl(link)?.href ?? link));
  return links.size === 1 ? [...links][0] : undefined;
}

/** Only http(s), so an agent cannot make the card open another scheme. */
export function secretRequestLink(request: Pick<SecretRequestFields, "url" | "reason">) {
  const raw = request.url ?? reasonLink(request.reason);
  const url = raw === undefined ? null : secretRequestPageUrl(raw);
  return url === null ? null : { href: url.href, host: url.host };
}

export type SecretRequestDisplay =
  | { kind: "pending" }
  | { kind: "pending-elsewhere"; label: string }
  | { kind: "answered"; outcome: "saved" | "declined" | "ended"; label: string };

/** secretRequestDisplay: a pending request asks, the others read as one line. */
export function secretRequestDisplay(request: Pick<SecretRequestFields, "status" | "visibility">): SecretRequestDisplay {
  switch (request.status) {
    case "pending": return (request.visibility ?? "local") === "local" ? { kind: "pending" } : { kind: "pending-elsewhere", label: "Waiting for an answer in the original thread" };
    case "saved": return { kind: "answered", outcome: "saved", label: "Saved securely and kept private" };
    case "declined": return { kind: "answered", outcome: "declined", label: "Declined" };
    case "cancelled": return { kind: "answered", outcome: "ended", label: "Request ended" };
  }
}

/** A configured secret provider a pending card can read its answer from (client-runtime SecretRequestSource). */
export interface SecretRequestSource {
  id: string;
  label: string;
  isReference: (reference: string) => boolean;
  referencePlaceholder: string;
  invalidReferenceMessage: string;
}

// secret-provider-onepassword definition.ts: the 1Password reference syntax and its account config.
const OP_NAME = String.raw`[A-Za-z0-9._-](?:[A-Za-z0-9 ._-]*[A-Za-z0-9._-])?`;
const OP_REFERENCE = new RegExp(String.raw`^op://${OP_NAME}(?:/${OP_NAME}){2,3}(?:\?[a-z-]+=[A-Za-z0-9_-]+)?$`);
const OP_ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const BUILT_IN_SECRET_PROVIDERS: Record<string, { validConfig: (config: unknown) => boolean; isReference: (reference: string) => boolean; referencePlaceholder: string; invalidReferenceMessage: string }> = {
  one_password: {
    validConfig: (config) => { const account = (config as { account?: unknown } | null)?.account; return typeof account === "string" && account.length <= 253 && OP_ACCOUNT.test(account); },
    isReference: (reference) => reference.length <= 1024 && OP_REFERENCE.test(reference),
    referencePlaceholder: "op://vault/item/field",
    invalidReferenceMessage: "Use a 1Password reference like op://vault/item/field.",
  },
};

/** secretRequestSources: empty unless the server accepts reference answers; providers this build cannot read are left out. */
export function secretRequestSources(referencesAccepted: boolean, providers: unknown): SecretRequestSource[] {
  if (!referencesAccepted || typeof providers !== "object" || providers === null) return [];
  return Object.entries(providers as Record<string, unknown>).flatMap(([id, value]) => {
    const provider = value as { kind?: unknown; label?: unknown; config?: unknown } | null;
    const definition = typeof provider?.kind === "string" ? BUILT_IN_SECRET_PROVIDERS[provider.kind] : undefined;
    if (!definition || !PROVIDER_ID.test(id) || id.length > 64 || !definition.validConfig(provider?.config)) return [];
    return [{ id, label: typeof provider?.label === "string" && provider.label ? provider.label : id, isReference: definition.isReference, referencePlaceholder: definition.referencePlaceholder, invalidReferenceMessage: definition.invalidReferenceMessage }];
  });
}

/** secretRequestReference: the reference `text` names, or undefined when it is not `source`'s syntax. */
export function secretRequestReference(source: SecretRequestSource, text: string): { provider: string; reference: string } | undefined {
  const reference = text.trim();
  if (reference.length === 0 || reference.length > 1024 || /[\r\n]/.test(reference) || !source.isReference(reference)) return undefined;
  return { provider: source.id, reference };
}

export type SecretRequestReply =
  | { type: "save"; secret: string; values?: never }
  | { type: "save"; values: Readonly<Record<string, string>>; secret?: never }
  | { type: "reference"; source: SecretRequestSource; reference: string }
  | { type: "decline" };

/** SecretRequestAnswerInput for `secrets.answerRequest`; blank inputs are refused. */
export function secretRequestAnswerInput(
  item: { id: string; threadId: string; label?: string; placeholder?: string; fields?: SecretRequestField[] },
  reply: SecretRequestReply,
) {
  if (reply.type === "decline") return { threadId: item.threadId, turnItemId: item.id, answer: { type: "decline" as const } };
  if (reply.type === "reference") {
    const reference = item.fields === undefined ? secretRequestReference(reply.source, reply.reference) : undefined;
    return reference === undefined ? null : { threadId: item.threadId, turnItemId: item.id, answer: { type: "reference" as const, reference } };
  }
  if (reply.values !== undefined) {
    const inputs = secretRequestInputs({ label: item.label ?? "", ...(item.placeholder !== undefined ? { placeholder: item.placeholder } : {}), ...(item.fields !== undefined ? { fields: item.fields } : {}) });
    const entries = inputs.map((input) => [input.key, secretRequestValue(reply.values!, input.key).trim()] as const);
    if (entries.some(([, value]) => value.length === 0)) return null;
    if (item.fields === undefined) return { threadId: item.threadId, turnItemId: item.id, answer: { type: "save" as const, secret: entries[0]?.[1] ?? "" } };
    return { threadId: item.threadId, turnItemId: item.id, answer: { type: "save" as const, values: Object.fromEntries(entries) } };
  }
  const secret = (reply.secret ?? "").trim();
  return secret.length === 0 ? null : { threadId: item.threadId, turnItemId: item.id, answer: { type: "save" as const, secret } };
}

const USER_FACING_FAILURE_TAGS = new Set(["SecretRequestError", "EnvironmentAuthorizationError"]);

/** Only known server errors pass their message through, so the typed value can never surface in the UI. */
export function secretRequestFailureMessage(failure: unknown): string {
  // A contract error decoded in place carries `_tag`; a failed RPC here is a RequestFailure carrying the tag as `tag`.
  const tag = typeof failure === "object" && failure !== null ? ("_tag" in failure ? failure._tag : "tag" in failure ? failure.tag : undefined) : undefined;
  if (typeof failure === "object" && failure !== null && typeof tag === "string" && USER_FACING_FAILURE_TAGS.has(tag) && "message" in failure && typeof failure.message === "string" && failure.message.trim().length > 0 && failure.message !== "Request failed") {
    return failure.message;
  }
  return "Could not answer the request. Try again.";
}

/** The request a `secret_request` turn item carries, or null when it lacks what the card needs. */
export function secretRequestFromTurnItem(item: Record<string, unknown>): SecretRequestFields | null {
  if (typeof item.threadId !== "string" || typeof item.label !== "string" || item.label.trim() === "") return null;
  const status = item.secretStatus;
  if (status !== "pending" && status !== "saved" && status !== "declined" && status !== "cancelled") return null;
  const fields: SecretRequestField[] | undefined = Array.isArray(item.fields)
    ? item.fields.flatMap((entry): SecretRequestField[] => {
        if (!entry || typeof entry !== "object") return [];
        const f = entry as Record<string, unknown>;
        if (typeof f.name !== "string" || typeof f.label !== "string") return [];
        return [{ name: f.name, label: f.label, ...(typeof f.placeholder === "string" ? { placeholder: f.placeholder } : {}), ...(typeof f.secret === "boolean" ? { secret: f.secret } : {}) }];
      })
    : undefined;
  return {
    threadId: item.threadId, label: item.label, reason: typeof item.reason === "string" ? item.reason : "", status,
    ...(typeof item.url === "string" ? { url: item.url } : {}),
    ...(typeof item.placeholder === "string" ? { placeholder: item.placeholder } : {}),
    ...(fields && fields.length > 0 ? { fields } : {}),
    ...(item.delivery === "file" ? { delivery: "file" as const } : {}),
    ...(item.rowVisibility === "inherited" || item.rowVisibility === "synthetic" ? { visibility: item.rowVisibility } : {}),
  };
}
