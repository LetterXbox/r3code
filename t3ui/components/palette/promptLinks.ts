// promptLinkFor / buildNewThreadLink (components/promptLinks/copyPromptLink.ts and
// packages/shared/src/promptLinks.ts): a shareable link that opens a new thread
// with the composer's prompt filled in.
export const PROMPT_LINK_MAX_PROMPT_LENGTH = 8_000;
export const DEFAULT_HOSTED_APP_URL = "https://app.t3.codes";

/** application/x-www-form-urlencoded, the encoding URLSearchParams.set gives. */
export function formEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()~]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/** The link for `prompt`, or null when it is empty or too long to fit in one. */
export function buildPromptLink(prompt: string, origin: string = DEFAULT_HOSTED_APP_URL): string | null {
  const trimmed = prompt.trim();
  if (trimmed.length === 0 || trimmed.length > PROMPT_LINK_MAX_PROMPT_LENGTH) return null;
  return `${origin.replace(/\/+$/, "")}/new?prompt=${formEncode(trimmed)}`;
}
