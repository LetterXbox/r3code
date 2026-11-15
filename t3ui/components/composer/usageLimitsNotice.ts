/** limitsNotice (shared/usageLimits.ts): why there are no bars, or null when there are. */
export function limitsNoticeFrom(input: { windows: number; unavailableReason: string | null; unavailableMessage: string | null }): string | null {
  if (input.unavailableReason === "unsupported") return input.unavailableMessage ?? "This account has no subscription limits.";
  if (input.unavailableReason === "probeFailed") return input.unavailableMessage ?? "Could not read limits.";
  return input.windows === 0 ? "No limits reported." : null;
}
