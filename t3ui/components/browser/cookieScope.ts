// Shared by every engine's cookie reader (CookieDatabase.ts in the reference): the imported-cookie shape and the
// url/domain a raw host+path+secure triple resolves to.
export interface ImportedCookie {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  /** Left undefined for host-only cookies: a supplied domain would be widened by a real cookie-store write. */
  readonly domain: string | undefined;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly expirationDate: number | undefined;
  readonly sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
}

export interface CookieReadResult {
  readonly cookies: ReadonlyArray<ImportedCookie>;
  readonly undecryptable: number;
  readonly undecryptableHosts: ReadonlyArray<string>;
}

export const bareHost = (host: string): string => (host.startsWith(".") ? host.slice(1) : host);

export function cookieScope(host: string, path: string, secure: boolean): { url: string; domain: string | undefined } {
  const isDomainCookie = host.startsWith(".");
  const unwrappedHost = bareHost(host);
  const authority = unwrappedHost.includes(":") && !(unwrappedHost.startsWith("[") && unwrappedHost.endsWith("]")) ? `[${unwrappedHost}]` : unwrappedHost;
  return {
    url: `${secure ? "https" : "http"}://${authority}${path}`,
    domain: isDomainCookie ? host : undefined,
  };
}
