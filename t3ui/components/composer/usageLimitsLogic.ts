// The composer's usage-limits banner (chat/ComposerUsageLimits.tsx, shared/usageLimits.ts): the
// `/usage-limits` command is offered only for a provider whose snapshot carries usage limits, and
// the banner shows that snapshot's windows: "N% left", a remaining bar, and when it resets.
import { limitsNoticeFrom } from "./usageLimitsNotice";

export interface LimitWindowView { id: string; label: string; usedPercent: number; resetsAt: string | null; windowDurationMins: number | null }
export interface LimitsView {
  windows: LimitWindowView[];
  notice: string | null;
  externalUsage: { label: string; url: string } | null;
  resetCredits: number | null;
}

export const USAGE_LIMITS_COMMAND = { name: "usage-limits", description: "Show this provider's usage limits" } as const;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Parse a provider snapshot's `usageLimits`; null when the provider reports none. */
export function parseUsageLimits(value: unknown): LimitsView | null {
  const limits = asRecord(value);
  if (!limits) return null;
  const windows = (Array.isArray(limits.windows) ? limits.windows : []).flatMap((entry): LimitWindowView[] => {
    const item = asRecord(entry);
    if (!item || typeof item.id !== "string" || typeof item.label !== "string" || typeof item.usedPercent !== "number") return [];
    return [{
      id: item.id, label: item.label, usedPercent: item.usedPercent,
      resetsAt: typeof item.resetsAt === "string" ? item.resetsAt : null,
      windowDurationMins: typeof item.windowDurationMins === "number" ? item.windowDurationMins : null,
    }];
  });
  const unavailable = asRecord(limits.unavailable);
  const external = asRecord(limits.externalUsage);
  const credits = asRecord(limits.resetCredits);
  return {
    windows,
    notice: limitsNoticeFrom({ windows: windows.length, unavailableReason: typeof unavailable?.reason === "string" ? unavailable.reason : null, unavailableMessage: typeof unavailable?.message === "string" ? unavailable.message : null }),
    externalUsage: external && typeof external.label === "string" && typeof external.url === "string" ? { label: external.label, url: external.url } : null,
    resetCredits: typeof credits?.availableCount === "number" ? credits.availableCount : null,
  };
}
