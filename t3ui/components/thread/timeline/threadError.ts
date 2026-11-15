// ThreadErrorBanner.tsx helpers: a JSON error payload shows its nested message,
// and a dismissed banner stays dismissed for the session.
export function getThreadErrorBannerMessage(error: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(error);
  } catch {
    return error;
  }
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return error;
  const nested = (payload as { error: unknown }).error;
  if (typeof nested !== "object" || nested === null || !("message" in nested)) return error;
  const message = (nested as { message: unknown }).message;
  return typeof message === "string" && message.trim().length > 0 ? message : error;
}

export function getThreadErrorBannerKey(threadKey: string, error: string | null): string | null {
  return error === null ? null : `${threadKey}\u0000${error}`;
}

const dismissed = new Set<string>();

export function dismissThreadErrorBannerForSession(key: string | null): void {
  if (key !== null) dismissed.add(key);
}

export function isThreadErrorBannerDismissedForSession(key: string | null): boolean {
  return key !== null && dismissed.has(key);
}

export function shouldShowThreadErrorBanner(threadKey: string, error: string | null): boolean {
  return getThreadErrorBannerKey(threadKey, error) !== null && !isThreadErrorBannerDismissedForSession(getThreadErrorBannerKey(threadKey, error));
}
