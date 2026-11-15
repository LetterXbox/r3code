// The icon a tool call carries (ToolActivityIcon, packages/contracts providerRuntime.ts) and the image it resolves to: a website's
// favicon, a themed logo. A native-app icon needs the environment's asset route, so it keeps the tool's own mark. Ported from
// packages/shared favicon.ts (toolActivityFaviconUrl) and chat/TimelineToolActivityIcon.tsx.
export type ToolIconFields =
  | { tag: "website"; pageUrl: string; faviconUrl?: string; faviconUrlDark?: string }
  | { tag: "themed-logo"; logoUrl: string; logoUrlDark?: string }
  | { tag: "native-app"; /** ToolActivityNativeAppReference: the app the icon is read from (the native-app-icon asset). */ app?: Record<string, unknown> };

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null);
const text = (value: unknown, max = 4096): string | undefined => (typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined);

/** The contract's tagged icon (`_tag`) as the timeline holds it, or undefined for anything else. */
export function toolIconFromWire(value: unknown): ToolIconFields | undefined {
  const icon = rec(value);
  if (!icon) return undefined;
  if (icon._tag === "website") {
    const pageUrl = text(icon.pageUrl);
    if (!pageUrl) return undefined;
    const faviconUrl = text(icon.faviconUrl);
    const faviconUrlDark = text(icon.faviconUrlDark);
    return { tag: "website", pageUrl, ...(faviconUrl ? { faviconUrl } : {}), ...(faviconUrlDark ? { faviconUrlDark } : {}) };
  }
  if (icon._tag === "themed-logo") {
    const logoUrl = text(icon.logoUrl);
    if (!logoUrl) return undefined;
    const logoUrlDark = text(icon.logoUrlDark);
    return { tag: "themed-logo", logoUrl, ...(logoUrlDark ? { logoUrlDark } : {}) };
  }
  if (icon._tag !== "native-app") return undefined;
  const app = rec(icon.app);
  return app ? { tag: "native-app", app } : { tag: "native-app" };
}

const THEMED_FAVICON_BY_HOSTNAME: Record<string, { light: string; dark: string }> = {
  "github.com": { light: "https://github.githubassets.com/favicons/favicon.svg", dark: "https://github.githubassets.com/favicons/favicon-dark.svg" },
};

function pageUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch { return null; }
}

/** Accepts image URLs supplied by a trusted provider event. */
function explicitUrl(raw: string | undefined): string | null {
  if (!raw || raw.length > 4096) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "data:" ? url.href : null;
  } catch { return null; }
}

/** toolActivityFaviconUrl: the explicit favicon for the appearance, a known themed one, else the page origin's /favicon.ico. */
export function toolIconImageUrl(icon: ToolIconFields | undefined, dark: boolean): string | null {
  if (!icon || icon.tag === "native-app") return null;
  if (icon.tag === "themed-logo") return explicitUrl(dark ? icon.logoUrlDark ?? icon.logoUrl : icon.logoUrl);
  const page = pageUrl(icon.pageUrl);
  const themed = page ? THEMED_FAVICON_BY_HOSTNAME[page.hostname.toLowerCase()]?.[dark ? "dark" : "light"] ?? null : null;
  const origin = page ? new URL("/favicon.ico", page.origin).href : null;
  const plain = explicitUrl(icon.faviconUrl);
  return dark ? explicitUrl(icon.faviconUrlDark) ?? themed ?? plain ?? origin : plain ?? themed ?? origin;
}

/** `toolIconAcceptsTint`: a tool with an icon of its own keeps its colours. */
export const toolIconAcceptsTint = (icon: ToolIconFields | undefined) => icon === undefined;
