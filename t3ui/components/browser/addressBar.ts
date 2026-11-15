// packages/shared/src/preview.ts resolveAddressBarInput / resolveSearchUrlTemplate / normalizePreviewUrl, and
// PreviewView.tsx handleSubmitUrl: what the browser's address field opens. Words search with the chosen engine; a host,
// address or URL opens; a non-web scheme is refused ("Could not open this address" / "Enter an http or https URL.").

export class PreviewUrlNormalizationError extends Error {
  constructor(readonly reason: "empty" | "parse" | "unsupported-protocol", readonly protocol?: string) { super(`Invalid preview URL (${reason}${protocol ? `: ${protocol}` : ""}).`); }
}

const ADDRESS_HOST_PATTERN = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:.]+\])$/i;
const BARE_HOST_PORT_PATTERN = /^[^/?#:@]+:\d+(?:[/?#]|$)/;
const URL_SCHEME_WITH_AUTHORITY_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;
const LOOPBACK_PREFIX_PATTERN = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::|\/|$)/i;
const KNOWN_NON_WEB_SCHEMES = new Set(["about:", "blob:", "chrome:", "data:", "file:", "ftp:", "javascript:", "mailto:", "sms:", "ssh:", "tel:", "view-source:", "ws:", "wss:"]);

export const BROWSER_SEARCH_URL_TEMPLATES: Record<string, string> = {
  duckduckgo: "https://duckduckgo.com/?q=%s",
  google: "https://www.google.com/search?q=%s",
  bing: "https://www.bing.com/search?q=%s",
  brave: "https://search.brave.com/search?q=%s",
  kagi: "https://kagi.com/search?q=%s",
  ecosia: "https://www.ecosia.org/search?q=%s",
};

const fill = (template: string, query: string) => template.replaceAll("%s", encodeURIComponent(query));
const protocolOf = (raw: string) => /^([A-Za-z][A-Za-z\d+.-]*):/.exec(raw)?.[1]?.toLowerCase().concat(":");

export function isValidSearchUrlTemplate(template: string): boolean {
  if (!template.includes("%s")) return false;
  try {
    const authority = (url: URL) => `${url.username}:${url.password}@${url.host}`;
    const a = new URL(fill(template, "a")); const b = new URL(fill(template, "b"));
    return (a.protocol === "http:" || a.protocol === "https:") && authority(a) === authority(b);
  } catch { return false; }
}

export function resolveSearchUrlTemplate(engine: unknown, custom: unknown): string {
  if (typeof engine === "string" && engine !== "custom" && BROWSER_SEARCH_URL_TEMPLATES[engine]) return BROWSER_SEARCH_URL_TEMPLATES[engine]!;
  const text = typeof custom === "string" ? custom.trim() : "";
  return engine === "custom" && isValidSearchUrlTemplate(text) ? text : BROWSER_SEARCH_URL_TEMPLATES.duckduckgo!;
}

export function normalizeAddressUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) throw new PreviewUrlNormalizationError("empty");
  const explicit = protocolOf(trimmed);
  if (explicit !== undefined && KNOWN_NON_WEB_SCHEMES.has(explicit)) throw new PreviewUrlNormalizationError("unsupported-protocol", explicit);
  const candidate = URL_SCHEME_WITH_AUTHORITY_PATTERN.test(trimmed) ? trimmed : `${LOOPBACK_PREFIX_PATTERN.test(trimmed) ? "http" : "https"}://${trimmed}`;
  let parsed: URL;
  try { parsed = new URL(candidate); } catch { throw new PreviewUrlNormalizationError("parse", protocolOf(candidate)); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new PreviewUrlNormalizationError("unsupported-protocol", parsed.protocol);
  return parsed.href;
}

export function resolveAddressBarInput(rawInput: string, searchUrlTemplate: string = BROWSER_SEARCH_URL_TEMPLATES.duckduckgo!): string {
  const trimmed = rawInput.trim();
  if (URL_SCHEME_WITH_AUTHORITY_PATTERN.test(trimmed) || trimmed.length === 0) return normalizeAddressUrl(trimmed);
  if (!/\s/.test(trimmed)) {
    const protocol = protocolOf(trimmed);
    if (protocol !== undefined && (KNOWN_NON_WEB_SCHEMES.has(protocol) || !BARE_HOST_PORT_PATTERN.test(trimmed))) {
      if (protocol !== "http:" && protocol !== "https:") throw new PreviewUrlNormalizationError("unsupported-protocol", protocol);
      return normalizeAddressUrl(trimmed);
    }
    const authority = trimmed.split(/[/?#]/, 1)[0] ?? "";
    const bare = authority.replace(/^[^@]*@/, "");
    const host = bare.replace(/:\d+$/, "");
    const hasPort = host.length < bare.length;
    if (hasPort || ADDRESS_HOST_PATTERN.test(host) || /^[^.]+(?:\.[^.]+)+\.?$/.test(host)) {
      try { return normalizeAddressUrl(trimmed); } catch { /* search instead */ }
    }
  }
  return fill(searchUrlTemplate, trimmed);
}
