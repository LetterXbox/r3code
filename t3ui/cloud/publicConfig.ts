// cloud/publicConfig.ts: the public configuration T3 Connect, the Clerk account pages and the relay need.
// The reference embeds it at build time from the repository-root `.env.example` (scripts/lib/public-config.ts
// maps T3CODE_* to VITE_*; docs/operations/connect-setup.md: "These values are public identifiers"). The port
// ships the same committed production values. No secret belongs here: CLERK_SECRET_KEY lives only in the relay.
//
// Every T3 Connect surface gates on hasCloudPublicConfig() as the reference does (settings search, the Welcome phone band
// through onboarding/phoneOffer.ts, the MCP wizard, the onboarding dialog, the Environments page's T3 Connect rows), then on
// the T3 Connect sign-in and the environment's relay permissions.

export interface CloudPublicConfig {
  clerkPublishableKey: string | null;
  clerkJwtTemplate: string | null;
  clerkCliOAuthClientId: string | null;
  relayUrl: string | null;
}

export const CLOUD_PUBLIC_CONFIG_KEYS = ["VITE_CLERK_PUBLISHABLE_KEY", "VITE_CLERK_JWT_TEMPLATE", "VITE_T3CODE_RELAY_URL"] as const;

/** The reference's committed .env.example (T3CODE_CLERK_PUBLISHABLE_KEY, _JWT_TEMPLATE, _CLI_OAUTH_CLIENT_ID, T3CODE_RELAY_URL). */
const SHIPPED_PUBLIC_CONFIG = {
  clerkPublishableKey: "pk_live_Y2xlcmsudDMuY29kZXMk",
  clerkJwtTemplate: "t3-relay",
  clerkCliOAuthClientId: "hzxSgY2cH10sDU2r",
  relayUrl: "https://relay.t3.codes",
} as const;

export function trimNonEmpty(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

/** normalizeSecureRelayUrl: an https origin without a trailing slash, or null. */
export function normalizeSecureRelayUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return null;
  }
}

export function resolveCloudPublicConfig(): CloudPublicConfig {
  return {
    clerkPublishableKey: trimNonEmpty(SHIPPED_PUBLIC_CONFIG.clerkPublishableKey),
    clerkJwtTemplate: trimNonEmpty(SHIPPED_PUBLIC_CONFIG.clerkJwtTemplate),
    clerkCliOAuthClientId: trimNonEmpty(SHIPPED_PUBLIC_CONFIG.clerkCliOAuthClientId),
    relayUrl: normalizeSecureRelayUrl(SHIPPED_PUBLIC_CONFIG.relayUrl),
  };
}

/** hasCloudPublicConfig: all three values present. The reference's browser-origin check applies only to hosted web
 * builds with a pk_live key; desktop (`window.desktopBridge`) skips it, and this is a desktop client. */
export function hasCloudPublicConfig(config: CloudPublicConfig = resolveCloudPublicConfig()): boolean {
  return Boolean(config.clerkPublishableKey && config.clerkJwtTemplate && config.relayUrl);
}

/** relayAuth.ts parseClerkFrontendApi: the Frontend API origin base64-encoded in the publishable key. */
export function clerkFrontendApiUrlFromPublishableKey(publishableKey: string): string {
  const prefix = publishableKey.startsWith("pk_live_") ? "pk_live_" : publishableKey.startsWith("pk_test_") ? "pk_test_" : null;
  if (prefix === null) throw new Error("Clerk publishable key has an unexpected prefix.");
  const frontendApi = atob(publishableKey.slice(prefix.length)).replace(/\$$/u, "");
  if (frontendApi.length === 0) throw new Error("Clerk publishable key has an empty Frontend API.");
  if (frontendApi.includes("/")) throw new Error("Clerk publishable key Frontend API contains a path.");
  const url = `https://${frontendApi}`;
  new URL(url);
  return url;
}
