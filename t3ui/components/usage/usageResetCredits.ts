// ChatGPT-style banked reset credits on the Limits tab: the summary line, the outcome copy and the redeem call
// (UsageLimits.tsx resetCreditsSummary / OUTCOME_TEXT / useResetCredit; RPC provider.consumeResetCredit).
import { formatDuration } from "./usageFormat";

export const CHATGPT_USAGE_URL = "https://chatgpt.com/#settings/Usage";

export interface ResetCredits { availableCount: number; nextExpiresAt: string }

const OUTCOME_TEXT: Record<string, string> = {
  reset: "Reset applied. Your windows have cleared.",
  nothingToReset: "Nothing to reset right now.",
  noCredit: "No reset credit left.",
  alreadyRedeemed: "That credit was already redeemed.",
};

export function resetCreditsSummary(credits: ResetCredits, now: number, compact = false): string {
  const at = Date.parse(credits.nextExpiresAt);
  const expiresIn = credits.nextExpiresAt && Number.isFinite(at) ? formatDuration(at - now) : null;
  if (credits.availableCount === 0) return "No reset credits banked";
  if (compact) return `${credits.availableCount} banked${expiresIn ? ` · expires in ${expiresIn}` : ""}`;
  return `${credits.availableCount} ${credits.availableCount === 1 ? "reset credit" : "reset credits"} banked${expiresIn ? ` · next expires in ${expiresIn}` : ""}`;
}

/** What the page says after a redemption; a server warning wins over the outcome copy. */
export function resetCreditStatus(result: unknown): string {
  const value = typeof result === "object" && result !== null ? (result as { outcome?: unknown; warning?: unknown }) : {};
  if (typeof value.warning === "string" && value.warning) return value.warning;
  return typeof value.outcome === "string" ? (OUTCOME_TEXT[value.outcome] ?? "Could not use the reset credit.") : "Could not use the reset credit.";
}

/** ProviderConsumeResetCreditInput: a provider instance, or a hub account's next credit. */
export type ResetCreditTarget = { instanceId: string } | { sourceId: string; accountId: string; creditId: string };

export async function redeemResetCredit(request: (method: string, payload: unknown) => Promise<unknown>, target: string | ResetCreditTarget): Promise<string> {
  try {
    return resetCreditStatus(await request("provider.consumeResetCredit", typeof target === "string" ? { instanceId: target } : target));
  } catch (cause) {
    return cause instanceof Error && cause.message ? cause.message : "Could not use the reset credit.";
  }
}
