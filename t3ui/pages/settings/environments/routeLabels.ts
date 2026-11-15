// connectionRouteLabel / connectionRouteAddress (client-runtime connection/routes.ts) over the host classification of
// packages/shared/src/hostClassification.ts, for the saved environments' bearer routes (an http(s)/ws(s) address).
const normalizeHostname = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/u, "");

const parseIpv4 = (host: string): readonly number[] | null => {
  const parts = normalizeHostname(host).split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
};

const parseIpv6 = (host: string): readonly number[] | null => {
  const normalized = normalizeHostname(host);
  if (!normalized.includes(":")) return null;
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  if ([...head, ...tail].some((part) => !/^[\da-f]{1,4}$/u.test(part))) return null;
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return [...head, ...Array.from({ length: missing }, () => "0"), ...tail].map((part) => Number.parseInt(part, 16));
};

const isPrivateIpv4 = (parts: readonly number[]): boolean =>
  parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
  (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) ||
  (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
  (parts[0] === 192 && parts[1] === 168) ||
  (parts[0] === 169 && parts[1] === 254) ||
  (parts[0] === 198 && parts[1]! >= 18 && parts[1]! <= 19);

export const isLocalLoopbackHost = (host: string): boolean => {
  const normalized = normalizeHostname(host);
  if (normalized === "localhost" || normalized === "::1") return true;
  return parseIpv4(normalized)?.[0] === 127;
};

export const isTailnetHost = (host: string): boolean => {
  const normalized = normalizeHostname(host);
  if (normalized.endsWith(".ts.net")) return true;
  const ipv6 = parseIpv6(normalized);
  return ipv6 !== null && ipv6[0] === 0xfd7a && ipv6[1] === 0x115c && ipv6[2] === 0xa1e0;
};

export const isSharedAddressSpaceHost = (host: string): boolean => {
  const parts = parseIpv4(host);
  return parts !== null && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
};

export const isPrivateNetworkHost = (host: string): boolean => {
  const normalized = normalizeHostname(host);
  if (normalized === "::" || isLocalLoopbackHost(normalized) || normalized.endsWith(".localhost") || normalized.endsWith(".local") ||
    normalized === "home.arpa" || normalized.endsWith(".home.arpa") || (!normalized.includes(".") && !normalized.includes(":"))) return true;
  if (normalized.endsWith(".ts.net")) return true;
  const parts = parseIpv4(normalized);
  if (parts) return isPrivateIpv4(parts);
  const first = normalized.split(":", 1)[0] ?? "";
  if (!normalized.includes(":") || !/^[\da-f]{1,4}$/u.test(first)) return false;
  const hextet = Number.parseInt(first, 16);
  return Number.isInteger(hextet) && ((hextet & 0xfe00) === 0xfc00 || (hextet & 0xffc0) === 0xfe80);
};

/** The route's http base URL (a ws address as its http twin). */
export function routeAddress(url: string): string | null {
  try {
    const parsed = new URL(url.replace(/^ws(s?):\/\//i, "http$1://"));
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

export function routeLabel(url: string): string {
  const address = routeAddress(url);
  const hostname = address === null ? null : new URL(address).hostname;
  if (hostname === null) return "Remote link";
  if (isLocalLoopbackHost(hostname)) return "This device";
  if (isTailnetHost(hostname)) return "Tailscale";
  if (isSharedAddressSpaceHost(hostname)) return "VPN";
  return isPrivateNetworkHost(hostname) ? "LAN" : hostname;
}

/** arrayMove of @dnd-kit/sortable. */
export function moveRoute<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, moved!);
  return next;
}
