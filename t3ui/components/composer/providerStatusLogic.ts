// Port of getProviderStatusBannerKey / getProviderStatusMessage (ProviderStatusBanner.tsx)
// over the native store's ProviderStatus. The compatibility-advisory branch has no data here.
import type { ProviderStatus } from "../../store";

export function getProviderStatusBannerKey(status: ProviderStatus | null): string | null {
  if (!status || status.status === "disabled") return null;
  if (status.status === "ready") return null;
  // Antigravity validates credentials at session start; unknown restart auth is not failure.
  if (status.driver === "antigravity" && status.installed && status.status === "warning" && status.authStatus === "unknown") return null;
  return [status.instanceId, status.status, status.authStatus, status.message ?? ""].join("\u0000");
}

export function shouldShowProviderStatusBanner(status: ProviderStatus | null, dismissedKey: string | null): boolean {
  const key = getProviderStatusBannerKey(status);
  return key !== null && key !== dismissedKey;
}

export function hasProviderSetup(status: ProviderStatus): boolean {
  return status.driver === "antigravity" || status.canAuthenticate || status.canInstall;
}

export function providerName(status: ProviderStatus): string {
  return status.name.trim() || status.driver;
}

export function getProviderStatusMessage(status: ProviderStatus): string {
  if (status.message) return status.message;
  if (!status.installed && hasProviderSetup(status)) return `Open provider setup to install ${status.driver} on this environment.`;
  if (status.authStatus === "unauthenticated") {
    if (hasProviderSetup(status)) return status.driver === "antigravity" ? "Open provider setup to sign in with Google." : "Open provider setup to sign in.";
    return "Sign in via the CLI to authenticate again.";
  }
  return status.status === "ready"
    ? "No models are available for this provider."
    : status.status === "error"
      ? `${providerName(status)} provider is unavailable.`
      : `${providerName(status)} provider has limited availability.`;
}

export function providerBannerTitle(status: ProviderStatus): string {
  const isUnauthenticated = status.status === "error" && status.authStatus === "unauthenticated";
  return isUnauthenticated ? `${providerName(status)} is unauthenticated` : `${providerName(status)} provider status`;
}

/** getAntigravitySendBlockReason (ChatView.logic.ts): why an Antigravity send is refused before it reaches the server. */
export function antigravitySendBlockReason(status: Pick<ProviderStatus, "driver" | "installed" | "authStatus" | "models" | "status"> | null | undefined, model: string): string | null {
  if (status?.driver !== "antigravity") return null;
  if (!status.installed) return "Install Antigravity in provider settings before sending.";
  if (status.authStatus === "unauthenticated") return "Sign in to Antigravity in provider settings before sending.";
  const slug = model.trim();
  if (slug.length === 0) return "Choose an Antigravity model before sending.";
  if (status.authStatus === "unknown") return null;
  if (status.models.length === 0) return "Refresh Antigravity models in provider settings before sending.";
  if (status.status === "ready" && slug !== "antigravity-default" && !status.models.some((entry) => entry.id === slug)) {
    return "That Antigravity model is no longer available. Choose another model.";
  }
  return null;
}
