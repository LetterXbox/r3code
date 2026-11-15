// The Limits tab's pooling (packages/shared/src/usageLimits.ts: collectLimitAccounts, collectLimitPools, collectLimitNotices,
// collectExternalUsageLinks): accounts signed in to the same provider login are merged across environments, then each driver's
// accounts are pooled window by window so one bar can show a segment per account.
import type { UsageLimitAccount, UsageLimitWindow } from "../../pages/utility-data";
import { elapsedShare, paceRemainingPercent, paceOf, type LimitPace } from "./usageFormat";
import { CHATGPT_USAGE_URL, type ResetCreditTarget } from "./usageResetCredits";

export const WINDOW_KIND_ORDER: Record<string, number> = { session: 0, weekly: 1, monthly: 2, other: 3 };
const kindRank = (kind: string | undefined) => WINDOW_KIND_ORDER[kind ?? "other"] ?? 3;

export interface PoolAccount {
  key: string;
  driver: string;
  displayName: string | null;
  email: string | undefined;
  plan: string | undefined;
  accentColor: string | undefined;
  environments: { environmentId: string; label: string }[];
  /** Where a hub account (no environment of its own) was read from; null for a signed-in provider. */
  sourceLabel: string | null;
  /** The account that reports the banked credits and is asked to redeem one: a provider instance, or a hub's next credit. */
  redeem: { environmentId: string; target: ResetCreditTarget } | null;
  windows: UsageLimitWindow[];
  resetCredits: UsageLimitAccount["resetCredits"];
  checkedAt: string;
}

export interface PoolMember { account: PoolAccount; window: UsageLimitWindow; refillPercent: number }
export interface PoolWindow {
  id: string; kind: string; label: string; members: PoolMember[];
  columns: (PoolMember | { account: PoolAccount; window: null })[];
  remainingPercent: number; usedPercent: number; pace: LimitPace | null;
  resets: { member: PoolMember; at: number; restoresPercent: number }[];
}
export interface LimitPool { driver: string; accounts: PoolAccount[]; windows: PoolWindow[] }

const checkedMillis = (value: string | undefined) => { const at = Date.parse(value ?? ""); return Number.isFinite(at) ? at : 0; };

const DEFAULT_NAMES: Record<string, string> = { codex: "Codex", claudeAgent: "Claude", cursor: "Cursor", grok: "Grok", antigravity: "Antigravity", opencode: "OpenCode", pi: "Pi", muse: "Muse Code", kiro: "Kiro" };

/** limitsNotice: the sentence an account that reports no usable limits gets, or null. */
export function limitsNotice(account: UsageLimitAccount): string | null {
  if (account.unavailableReason === "unsupported") return account.unavailableMessage || "This account has no subscription limits.";
  if (account.unavailableReason === "probeFailed") return account.unavailableMessage || "Could not read limits.";
  return account.windows.length === 0 ? "No limits reported." : null;
}

function accountKey(account: UsageLimitAccount): string | null {
  const email = account.email?.trim().toLowerCase();
  if (email) return `${account.driver}:${email}`;
  return account.credentialFingerprint ? `${account.driver}:credential:${account.credentialFingerprint}` : null;
}

/** accountKeyResolver: a login with one known workspace keys by it, with several the unqualified login is ambiguous. */
function keyResolver(accounts: readonly UsageLimitAccount[]) {
  const workspaces = new Map<string, Set<string>>();
  for (const account of accounts) {
    const key = accountKey(account);
    if (key && account.workspaceId) workspaces.set(key, (workspaces.get(key) ?? new Set()).add(account.workspaceId));
  }
  return (account: UsageLimitAccount): string | null => {
    const key = accountKey(account);
    if (!key) return null;
    if (account.workspaceId) return `${key}:${account.workspaceId}`;
    const known = workspaces.get(key);
    if (!known) return key;
    return known.size === 1 ? `${key}:${[...known][0]}` : null;
  };
}

/** The accounts of the selected environments, merged by login; one that reports no limits becomes a notice instead. */
export function collectPoolAccounts(accounts: readonly UsageLimitAccount[]): PoolAccount[] {
  const merged = new Map<string, PoolAccount>();
  const resolve = keyResolver(accounts.filter((account) => account.authenticated !== false));
  const labelEnvironment = new Set(accounts.map((account) => account.environmentId ?? "")).size > 1;
  const hubPreferred = new Map<string, PoolAccount>();
  for (const account of accounts) {
    if (limitsNotice(account) !== null) continue;
    const environmentId = account.environmentId ?? "";
    const key = resolve(account) ?? `${environmentId}:${account.id}`;
    const hub = account.sourceId !== undefined;
    const next: PoolAccount = {
      key: hub ? `${account.sourceId}:${account.hubAccountId}${account.workspaceId ? `:${account.workspaceId}` : ""}` : `${environmentId}:${account.id}`, driver: account.driver, displayName: account.displayName ?? null, email: account.email, plan: account.plan,
      accentColor: hub ? undefined : account.accentColor, environments: hub ? [] : [{ environmentId, label: account.environmentLabel ?? environmentId }],
      sourceLabel: hub ? (labelEnvironment ? `${account.environmentLabel ?? environmentId} · ${account.sourceLabel}` : account.sourceLabel ?? null) : null,
      redeem: hub ? (account.resetCredits?.nextCreditId ? { environmentId, target: { sourceId: account.sourceId as string, accountId: account.hubAccountId as string, creditId: account.resetCredits.nextCreditId } } : null) : { environmentId, target: { instanceId: account.id } },
      windows: account.windows, resetCredits: account.resetCredits, checkedAt: account.checkedAt ?? "",
    };
    // A hub's redemption also clears its routing cooldown, so it is preferred while the balance shown follows the freshest read.
    const previousHub = hubPreferred.get(key);
    if (hub && next.redeem && (!previousHub || checkedMillis(next.checkedAt) > checkedMillis(previousHub.checkedAt))) hubPreferred.set(key, next);
    const previous = merged.get(key);
    if (!previous) { merged.set(key, next); continue; }
    const fresher = checkedMillis(next.checkedAt) > checkedMillis(previous.checkedAt);
    const winner = fresher ? next : previous;
    // The freshest read that carries credits names the balance, and the account that reports it redeems.
    const creditSource = [previous, next].filter((entry) => entry.resetCredits).sort((a, b) => checkedMillis(b.checkedAt) - checkedMillis(a.checkedAt))[0];
    const plan = [previous, next].filter((entry) => entry.plan).sort((a, b) => checkedMillis(b.checkedAt) - checkedMillis(a.checkedAt))[0]?.plan;
    // A hub's e-mail names the account better than the driver's default instance name.
    const hubEmail = [previous, next].some((entry) => entry.environments.length === 0 && entry.email);
    const displayName = previous.displayName ?? next.displayName;
    const environments = [...previous.environments, ...next.environments.filter((candidate) => !previous.environments.some((seen) => seen.environmentId === candidate.environmentId))];
    merged.set(key, {
      ...previous, plan: plan ?? previous.plan, accentColor: previous.accentColor ?? next.accentColor,
      displayName: hubEmail && displayName !== null && displayName.toLowerCase() === (DEFAULT_NAMES[previous.driver] ?? "").toLowerCase() ? null : displayName,
      environments, sourceLabel: environments.length > 0 ? null : previous.sourceLabel ?? next.sourceLabel,
      redeem: hubPreferred.get(key)?.redeem ?? (creditSource ? creditSource.redeem : winner.redeem), windows: winner.windows, resetCredits: creditSource?.resetCredits ?? null, checkedAt: winner.checkedAt,
    });
  }
  return [...merged.values()];
}

/** collectLimitNotices: what an account that reports no usable limits says, named by environment once there are several. */
export function collectLimitNotices(accounts: readonly UsageLimitAccount[], environmentCount: number, sources: readonly { id: string; label: string; error: string; accountCount: number; environmentLabel: string }[] = []): string[] {
  const notices: string[] = [];
  for (const source of sources) {
    const name = environmentCount > 1 ? `${source.environmentLabel} · ${source.label}` : source.label;
    if (source.error) notices.push(`${name}: ${source.error}`);
    else if (source.accountCount === 0) notices.push(`${name}: No accounts reported.`);
  }
  for (const account of accounts) {
    // A hub account that reports nothing usable is left out silently; its source speaks for it above.
    if (account.sourceId !== undefined || account.unavailableReason === "unsupported") continue;
    const notice = limitsNotice(account);
    if (!notice) continue;
    const name = account.displayName?.trim() || account.driver;
    notices.push(`${environmentCount > 1 ? `${account.environmentLabel ?? account.environmentId ?? ""} · ${name}` : name}: ${notice}`);
  }
  return notices;
}

export interface ExternalUsageLink { label: string; url: string; message: string | undefined; accounts: string[] }
export function collectExternalUsageLinks(accounts: readonly UsageLimitAccount[]): ExternalUsageLink[] {
  const links = new Map<string, ExternalUsageLink>();
  for (const account of accounts) {
    if (!account.externalUsage || account.authenticated === false || account.sourceId !== undefined) continue;
    const name = `${account.displayName ?? account.id} on ${account.environmentLabel ?? account.environmentId ?? ""}`;
    links.set(account.externalUsage.url, {
      label: account.externalUsage.label, url: account.externalUsage.url, message: account.unavailableMessage || undefined,
      accounts: [...new Set([...(links.get(account.externalUsage.url)?.accounts ?? []), name])],
    });
  }
  return [...links.values()];
}
export { CHATGPT_USAGE_URL };

const resetMillis = (window: UsageLimitWindow): number | null => { if (!window.resetsAt) return null; const at = Date.parse(window.resetsAt); return Number.isFinite(at) ? at : null; };
/** Codex ids name slots, so pool by kind; other drivers' ids identify distinct allowances. */
const poolKey = (driver: string, window: UsageLimitWindow) => driver === "codex" ? window.kind ?? "other" : `${window.kind ?? "other"}:${window.id}`;

function poolMember(account: PoolAccount, reported: UsageLimitWindow, now: number): PoolMember {
  const spentWeekly = reported.kind === "session"
    ? account.windows.find((window) => window.usedPercent >= 100 && (account.driver === "claudeAgent" ? window.id === "seven_day" : account.driver === "codex" && window.kind === "weekly"))
    : undefined;
  if (!spentWeekly) return { account, window: reported, refillPercent: reported.usedPercent };
  const weeklyReset = resetMillis(spentWeekly);
  const sessionReset = resetMillis(reported);
  const cutoff = Math.max(now, checkedMillis(account.checkedAt));
  let resetsAt = ""; let refillPercent = 0;
  // A stale or missing clock cannot tell us when blocked quota becomes usable.
  if (weeklyReset !== null && sessionReset !== null && weeklyReset > cutoff && sessionReset > cutoff) {
    if (sessionReset <= weeklyReset) { resetsAt = spentWeekly.resetsAt; refillPercent = 100; }
    else if (reported.usedPercent >= 100) { resetsAt = reported.resetsAt; refillPercent = 100; }
    else { resetsAt = spentWeekly.resetsAt; refillPercent = 100 - Math.max(0, Math.min(100, reported.usedPercent)); }
  }
  return { account, window: { ...reported, usedPercent: 100, resetsAt, windowDurationMins: null }, refillPercent };
}

function paceOfShares(used: number, elapsed: number): LimitPace {
  const gap = used - elapsed * 100;
  return gap > 5 ? "ahead" : gap < -5 ? "under" : "on";
}

function poolWindows(accounts: PoolAccount[], now: number): PoolWindow[] {
  const byKey = new Map<string, PoolMember[]>();
  for (const account of accounts) for (const reported of account.windows) {
    const member = poolMember(account, reported, now);
    const pooled = poolKey(account.driver, member.window);
    const key = byKey.get(pooled)?.some((entry) => entry.account === account) ? `${member.window.kind ?? "other"}:${member.window.id}` : pooled;
    const list = byKey.get(key);
    if (list) list.push(member); else byKey.set(key, [member]);
  }
  const pools = [...byKey].map(([key, members]): PoolWindow => {
    const byAccount = new Map(members.map((member) => [member.account.key, member]));
    const first = members[0]!.window;
    const used = members.reduce((sum, member) => sum + member.window.usedPercent, 0) / members.length;
    // Judge pace only for windows with reset clocks; others add spend without elapsed time.
    const timed = members.flatMap((member) => { const share = elapsedShare(member.window, now); return share === null ? [] : [{ used: member.window.usedPercent, elapsed: share }]; });
    const timedUsed = timed.reduce((sum, entry) => sum + entry.used, 0) / timed.length;
    const meanElapsed = timed.length > 0 ? timed.reduce((sum, entry) => sum + entry.elapsed, 0) / timed.length : null;
    const resets = members.flatMap((member) => { const at = resetMillis(member.window); return at === null ? [] : [{ member, at, restoresPercent: Math.round(member.refillPercent / members.length) }]; }).sort((a, b) => a.at - b.at);
    return {
      id: members[0]!.account.driver === "codex" ? key : first.id, kind: first.kind ?? "other", label: first.label, members,
      columns: accounts.map((account) => byAccount.get(account.key) ?? { account, window: null }),
      usedPercent: Math.round(used), remainingPercent: Math.round(100 - used), pace: meanElapsed === null ? null : paceOfShares(timedUsed, meanElapsed), resets,
    };
  });
  return pools.sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
}

const accountSortName = (account: PoolAccount) => (account.displayName ?? account.email ?? account.key).toLowerCase();

export function collectLimitPools(accounts: readonly PoolAccount[], now: number): LimitPool[] {
  const byDriver = new Map<string, PoolAccount[]>();
  for (const account of accounts) byDriver.set(account.driver, [...(byDriver.get(account.driver) ?? []), account]);
  return [...byDriver].map(([driver, members]) => {
    const orderWindow = members.flatMap((account) => account.windows).sort((a, b) => kindRank(a.kind) - kindRank(b.kind))[0];
    const orderReset = (account: PoolAccount) => {
      const window = account.windows.find((entry) => orderWindow && poolKey(driver, entry) === poolKey(driver, orderWindow));
      return (window ? resetMillis(poolMember(account, window, now).window) : null) ?? Number.POSITIVE_INFINITY;
    };
    const sorted = [...members].sort((a, b) => orderReset(a) - orderReset(b) || accountSortName(a).localeCompare(accountSortName(b)) || a.key.localeCompare(b.key));
    return { driver, accounts: sorted, windows: poolWindows(sorted, now) };
  });
}

const CURSOR_RANK: Record<string, number> = { totalPercentUsed: 0, autoPercentUsed: 1, apiPercentUsed: 2 };
/** displayLimitWindows: Antigravity lists Gemini first; Cursor drops the total when both of its pools report. */
export function displayLimitWindows(pool: LimitPool): PoolWindow[] {
  if (pool.driver === "antigravity") {
    const strip = (id: string) => id.replace(/-(5h|weekly|quota)$/, "");
    return [...pool.windows].sort((a, b) => Number(!a.id.startsWith("gemini-")) - Number(!b.id.startsWith("gemini-")) || strip(a.id).localeCompare(strip(b.id)) || kindRank(a.kind) - kindRank(b.kind));
  }
  if (pool.driver !== "cursor") return pool.windows;
  const both = pool.windows.some((window) => window.id === "autoPercentUsed") && pool.windows.some((window) => window.id === "apiPercentUsed");
  return pool.windows.filter((window) => !both || window.id !== "totalPercentUsed").sort((a, b) => (CURSOR_RANK[a.id] ?? 3) - (CURSOR_RANK[b.id] ?? 3));
}

/** CURSOR_USAGE_WINDOWS (shared/usageLimits.ts): the label and description a Cursor allowance shows. */
const CURSOR_DETAILS: Record<string, { label: string; description: string }> = {
  totalPercentUsed: { label: "Overall", description: "Combined usage across both allowances, not a third quota." },
  autoPercentUsed: { label: "Cursor Models", description: "Grok and Composer use this first. Auto can use either pool." },
  apiPercentUsed: { label: "Other Models", description: "Claude, GPT, and Gemini use this pool. Grok and Composer fall back here." },
};
export const cursorWindowDetails = (id: string) => CURSOR_DETAILS[id];

export { paceRemainingPercent, paceOf };

/** formatUpcomingTimestamp (timestampFormat.ts) for the locale format: a time today, "tomorrow at <time>", else "M/D <time>". */
export function formatUpcomingTimestamp(iso: string, now: number): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = (value: Date) => Math.floor(new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime() / 86_400_000);
  const diff = day(date) - day(new Date(now));
  if (diff <= 0) return time;
  if (diff === 1) return `tomorrow at ${time}`;
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return `${date.getMonth() + 1}/${date.getDate()}${sameYear ? "" : `/${String(date.getFullYear()).slice(-2)}`} ${time}`;
}

/** accountInitials / accountHue (UsageLimitsPooled.tsx): the chip an e-mail-only account shows. */
export function accountInitials(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "?";
}
export function accountHue(email: string): number {
  let hash = 0;
  for (let index = 0; index < email.length; index += 1) hash = (hash * 31 + email.charCodeAt(index)) | 0;
  return Math.abs(hash) % 360;
}
function hsl(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, "0"); };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}
/** The chip's pastel background and its darker initials (oklch 0.85 / 0.35 in the web, approximated in HSL). */
export function accountChipColors(email: string): { background: string; foreground: string } {
  const hue = accountHue(email);
  return { background: hsl(hue, 0.6, 0.82), foreground: hsl(hue, 0.55, 0.25) };
}

/**
 * paceMarkStyles (UsageLimits.tsx): the tick sits at the time left, clamped 3pt inside the bar, and a 6pt slot is cut out of the
 * bar's layers around it. Below 6pt there is no room for either. The web clips with a polygon; a native view masks with a
 * gradient whose alpha is zero across the slot.
 */
export function paceMark(timeLeft: number | null, width: number): { tick: number; mask: string } | null {
  if (timeLeft === null || width < 6) return null;
  const at = Math.min(width - 3, Math.max(3, (width * timeLeft) / 100));
  const left = Math.round((at - 3) * 100) / 100; const right = Math.round((at + 3) * 100) / 100;
  return { tick: at, mask: `linear-gradient(to right, black ${left}px, transparent ${left}px, transparent ${right}px, black ${right}px)` };
}
