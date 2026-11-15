// packages/shared/src/promptLinks.ts (parse side) and remote.ts readPairingAppLink, 1:1: what a t3code:// link or a
// hosted /new?prompt link asks for.
import { DEFAULT_HOSTED_APP_URL, PROMPT_LINK_MAX_PROMPT_LENGTH } from "../components/palette/promptLinks";

export interface PromptLinkRepository { readonly owner: string; readonly name: string }
export interface PromptLinkPullRequest extends PromptLinkRepository { readonly number: number }
export interface LinkedPrompt { readonly text: string; readonly hiddenCharacters: number }
export type NewThreadLink =
  | { readonly kind: "new"; readonly prompt: LinkedPrompt; readonly repository: PromptLinkRepository | null; readonly provider: string | null; readonly model: string | null }
  | { readonly kind: "pull-request"; readonly pullRequest: PromptLinkPullRequest; readonly prompt: LinkedPrompt | null };
export type PromptLinkResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

// oxlint-disable-next-line no-misleading-character-class -- these are the characters it removes.
const HIDDEN_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0D\uFEFF\uFFA0\uFFF0-\uFFFB\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}]/gu;
const isEmojiPart = (codePoint: number | undefined) =>
  codePoint !== undefined && ((codePoint >= 0x1f000 && codePoint <= 0x1faff) || (codePoint >= 0x2190 && codePoint <= 0x2bff) || codePoint === 0xfe0f);

export function sanitizeLinkedPrompt(raw: string): LinkedPrompt {
  let hiddenCharacters = 0;
  const visible = Array.from(raw.replace(/\r\n?|[\u2028\u2029]/g, "\n").replace(HIDDEN_CHARACTERS, () => { hiddenCharacters++; return ""; }));
  const text = visible.filter((character, index) => {
    if (character !== "\u200D") return true;
    const kept = isEmojiPart(visible[index - 1]?.codePointAt(0)) && isEmojiPart(visible[index + 1]?.codePointAt(0));
    if (!kept) hiddenCharacters++;
    return kept;
  }).join("");
  return { text: text.trim(), hiddenCharacters };
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

function repositoryOf(owner: string, name: string): PromptLinkRepository | null {
  const trimmedName = name.replace(/\.git$/i, "");
  if (!OWNER.test(owner) || !NAME.test(trimmedName) || /^\.+$/.test(trimmedName)) return null;
  return { owner, name: trimmedName };
}

export function parsePromptLinkRepository(value: string): PromptLinkRepository | null {
  const trimmed = value.trim();
  const url = /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)\/?$/i.exec(trimmed);
  const short = /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
  const match = url ?? short;
  return match?.[1] && match[2] ? repositoryOf(match[1], match[2]) : null;
}

function parsePromptLinkPullRequest(value: string): PromptLinkPullRequest | null {
  const trimmed = value.trim();
  const match = /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(trimmed)
    ?? /^([^/\s#]+)\/([^/\s#]+)(?:\/|#)(\d+)$/.exec(trimmed);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const repository = repositoryOf(match[1], match[2]);
  const number = Number(match[3]);
  return repository && Number.isSafeInteger(number) && number > 0 ? { ...repository, number } : null;
}

function readPrompt(params: URLSearchParams): PromptLinkResult<LinkedPrompt | null> {
  const raw = params.get("prompt");
  if (raw === null) return { ok: true, value: null };
  if (raw.length > PROMPT_LINK_MAX_PROMPT_LENGTH) {
    return { ok: false, error: `This prompt is longer than ${PROMPT_LINK_MAX_PROMPT_LENGTH.toLocaleString("en-US")} characters, so T3 Code did not open it.` };
  }
  const prompt = sanitizeLinkedPrompt(raw);
  if (prompt.text.length === 0 && prompt.hiddenCharacters > 0) {
    return { ok: false, error: "This prompt had only hidden characters, so it may be malicious. T3 Code did not open it." };
  }
  return { ok: true, value: prompt.text.length > 0 ? prompt : null };
}

const optionalParam = (params: URLSearchParams, key: string) => params.get(key)?.trim() || null;

export function parseNewThreadLink(search: string): PromptLinkResult<NewThreadLink> {
  const params = new URLSearchParams(search);
  const prompt = readPrompt(params);
  if (!prompt.ok) return prompt;
  const pr = params.get("pr");
  if (pr !== null) {
    const pullRequest = parsePromptLinkPullRequest(pr);
    if (pullRequest === null) return { ok: false, error: "This link names a pull request T3 Code cannot read." };
    return { ok: true, value: { kind: "pull-request", pullRequest, prompt: prompt.value } };
  }
  if (prompt.value === null) return { ok: false, error: "This link has no prompt." };
  const repo = params.get("repo");
  const repository = repo === null ? null : parsePromptLinkRepository(repo);
  if (repo !== null && repository === null) return { ok: false, error: "This link names a repository T3 Code cannot read." };
  return { ok: true, value: { kind: "new", prompt: prompt.value, repository, provider: optionalParam(params, "provider")?.toLowerCase() ?? null, model: optionalParam(params, "model") } };
}

export function parseThreadLinkPrompt(search: string): PromptLinkResult<LinkedPrompt | null> {
  return readPrompt(new URLSearchParams(search));
}

const APP_SCHEME = /^t3code(?:-[a-z]+)?:$/;
const THREAD_PATH = /^\/([^/]+)\/([^/]+)\/?$/;

export function promptLinkAppPath(value: string, hostedAppUrl: string = DEFAULT_HOSTED_APP_URL): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (APP_SCHEME.test(url.protocol)) {
    if (url.host === "new" && (url.pathname === "" || url.pathname === "/")) return `/new${url.search}`;
    const thread = url.host === "threads" ? THREAD_PATH.exec(url.pathname) : null;
    return thread ? `/${thread[1]}/${thread[2]}${url.search}` : null;
  }
  if (!URL.canParse(hostedAppUrl) || url.origin !== new URL(hostedAppUrl).origin) return null;
  if (url.pathname === "/new") return `/new${url.search}`;
  const thread = url.pathname.startsWith("/threads/")
    ? THREAD_PATH.exec(url.pathname.slice("/threads".length))
    : url.searchParams.has("prompt") ? THREAD_PATH.exec(url.pathname) : null;
  return thread ? `/${thread[1]}/${thread[2]}${url.search}` : null;
}

export function readPairingAppLink(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (!APP_SCHEME.test(url.protocol) || url.host !== "pair") return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  return url.searchParams.get("pairingUrl")?.trim() || null;
}

/** DesktopWebLinks.isWebLink / isWebPageFile. */
export function isWebLink(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
}
export const isWebPageFile = (path: string) => /\.x?html?$/i.test(path);

const isLoopbackHost = (host: string) => ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(host);

/** packages/shared/src/providerAuthReturnUrl.ts: where a provider sign-in returns to (Settings or the Welcome page). */
export function providerAuthReturnUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const desktop = APP_SCHEME.test(url.protocol) && url.host === "app";
    const web = ["http:", "https:"].includes(url.protocol) && (isLoopbackHost(url.hostname) || url.origin === "https://app.t3.codes");
    if (url.username || url.password || (!desktop && !web) || (url.pathname !== "/welcome" && url.pathname !== "/settings" && !url.pathname.startsWith("/settings/"))) return undefined;
    for (const key of Array.from(url.searchParams.keys())) {
      if (url.pathname === "/welcome" || !["machine", "project", "checkout", "environmentId", "instanceId"].includes(key)) url.searchParams.delete(key);
    }
    if (url.pathname !== "/welcome" || !/^#agents:[\w-]+$/u.test(url.hash)) url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

/** DesktopClerk resumeProviderAuth: an app link (`t3code://app/...`) back into provider setup. */
export function providerAuthReturnPath(value: string): string | null {
  const destination = providerAuthReturnUrl(value);
  if (!destination) return null;
  const url = new URL(destination);
  if (!APP_SCHEME.test(url.protocol) || url.host !== "app") return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
