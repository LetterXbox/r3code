export interface PullRequestEntry {
  host: string;
  projectId: string;
  repository: string;
  number: number;
  title: string;
  url: string;
  author: string;
  headBranch: string;
  baseBranch: string;
  state: string;
  isDraft: boolean;
  updatedAt: string;
  createdAt: string;
  additions: number;
  deletions: number;
  viewerReviewRequested: boolean;
  mergeability: string;
  checksState: string;
  reviewDecision: string;
  provider: string;
  projectTitle: string;
  authorAvatarUrl: string;
  labels: { name: string; color: string }[];
  /** PullRequestStackMembership: the stack this one is a layer of, when the host stacks them. */
  stack?: { number: number; position: number; size: number };
}

export interface PullRequestProvider {
  host: string;
  kind: string;
  searchesOnHost: boolean;
  configured: boolean;
  detail: string;
  /** The change request actions the host takes (PullRequestProviderSummary.actions). */
  actions: string[];
}

export interface PullRequestPage {
  entries: PullRequestEntry[];
  viewers: Record<string, string>;
  providers: PullRequestProvider[];
  errors: string[];
  nextCursors: Record<string, string>;
  truncated: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parsePullRequestPage(value: unknown): PullRequestPage {
  if (!record(value) || !Array.isArray(value.entries) || !Array.isArray(value.errors) || !record(value.nextCursors)) {
    throw new Error("The server returned an invalid pull request list.");
  }
  const entries = value.entries.map((entry): PullRequestEntry => {
    if (!record(entry) || !text(entry.repository) || !text(entry.title) || !text(entry.url) || !text(entry.projectId) || finite(entry.number) <= 0) {
      throw new Error("The server returned an invalid pull request.");
    }
    return {
      host: text(entry.host), projectId: text(entry.projectId), repository: text(entry.repository),
      number: finite(entry.number), title: text(entry.title), url: text(entry.url),
      author: record(entry.author) ? text(entry.author.login) : "",
      headBranch: text(entry.headBranch), baseBranch: text(entry.baseBranch), state: text(entry.state),
      isDraft: entry.isDraft === true, updatedAt: text(entry.updatedAt), createdAt: text(entry.createdAt),
      additions: finite(entry.additions), deletions: finite(entry.deletions),
      viewerReviewRequested: entry.viewerReviewRequested === true,
      mergeability: text(entry.mergeability), checksState: text(entry.checksState), reviewDecision: text(entry.reviewDecision),
      provider: text(entry.provider), projectTitle: text(entry.projectTitle),
      authorAvatarUrl: record(entry.author) ? text(entry.author.avatarUrl) : "",
      labels: Array.isArray(entry.labels) ? entry.labels.flatMap((label) => record(label) && text(label.name) ? [{ name: text(label.name), color: text(label.color) }] : []) : [],
      ...(record(entry.stack) && finite(entry.stack.number) > 0 ? { stack: { number: finite(entry.stack.number), position: finite(entry.stack.position), size: finite(entry.stack.size) } } : {}),
    };
  });
  const errors = value.errors.map((error) => record(error) ? `${text(error.projectTitle)}: ${text(error.message)}` : "Unknown project error");
  const nextCursors: Record<string, string> = {};
  for (const [key, cursor] of Object.entries(value.nextCursors)) {
    if (typeof cursor === "string") nextCursors[key] = cursor;
  }
  const viewers: Record<string, string> = {};
  if (record(value.viewers)) for (const [key, viewer] of Object.entries(value.viewers)) if (typeof viewer === "string") viewers[key] = viewer;
  const providers = Array.isArray(value.providers)
    ? value.providers.flatMap((provider): PullRequestProvider[] => record(provider) && text(provider.host)
      ? [{ host: text(provider.host), kind: text(provider.kind), searchesOnHost: provider.searchesOnHost === true, configured: provider.configured !== false, detail: text(provider.detail), actions: Array.isArray(provider.actions) ? provider.actions.filter((action): action is string => typeof action === "string") : [] }]
      : [])
    : [];
  return { entries, viewers, providers, errors, nextCursors, truncated: value.truncated === true };
}

export function sortPullRequests(entries: PullRequestEntry[], key: string): PullRequestEntry[] {
  return [...entries].sort((a, b) => {
    if (key === "Newest shown") return b.createdAt.localeCompare(a.createdAt);
    if (key === "Oldest shown") return a.createdAt.localeCompare(b.createdAt);
    if (key === "Largest shown") return (b.additions + b.deletions) - (a.additions + a.deletions);
    if (key === "Smallest shown") return (a.additions + a.deletions) - (b.additions + b.deletions);
    if (key === "Blocked on me") return Number(b.viewerReviewRequested) - Number(a.viewerReviewRequested) || b.updatedAt.localeCompare(a.updatedAt);
    if (key === "Merge readiness") {
      const score = (entry: PullRequestEntry) => Number(!entry.isDraft) + Number(entry.mergeability === "mergeable") + Number(entry.checksState === "passing") + Number(entry.reviewDecision === "approved");
      return score(b) - score(a) || b.updatedAt.localeCompare(a.updatedAt);
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export interface UsageBucket {
  day: string;
  hourStart: string;
  sessions: number;
  categoryCost: { input: number; cacheRead: number; cacheWrite: number; output: number } | null;
  provider: string;
  model: string;
  costUsd: number;
  cacheSavingsUsd: number;
  /** Cost of fast and ultrafast service, and what the speed premium added (UsageBucket.fastCostUsd and friends). */
  fastCostUsd?: number;
  ultrafastCostUsd?: number;
  speedPremiumUsd?: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
}

export interface UsageResult {
  buckets: UsageBucket[];
  sessions: number;
  issues: string[];
  unpricedRecords: number;
  refreshing: boolean;
  sessionsByProvider: Record<string, number>;
  /** The server's pricing status, for the page's "prices unavailable" copy. */
  pricingStatus: string;
}

export function parseUsage(value: unknown): UsageResult {
  if (!record(value) || !Array.isArray(value.buckets) || !Array.isArray(value.sources)) {
    throw new Error("The server returned an invalid usage summary.");
  }
  let unpricedRecords = 0;
  const buckets = value.buckets.map((bucket): UsageBucket => {
    if (!record(bucket) || !record(bucket.totals) || !text(bucket.day) || !text(bucket.provider) || !text(bucket.model)) {
      throw new Error("The server returned an invalid usage bucket.");
    }
    unpricedRecords += finite(bucket.unpricedRecords);
    const totals = bucket.totals;
    const numbers = [bucket.costUsd, bucket.cacheSavingsUsd, totals.uncachedInputTokens, totals.cachedInputTokens, totals.cacheCreationTokens, totals.outputTokens];
    if (numbers.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
      throw new Error("The server returned invalid usage totals.");
    }
    const category = record(bucket.categoryCostUsd) ? bucket.categoryCostUsd : null;
    return { hourStart: text(bucket.hourStart), sessions: finite(bucket.sessions), categoryCost: category ? { input: finite(category.input), cacheRead: finite(category.cacheRead), cacheWrite: finite(category.cacheWrite), output: finite(category.output) } : null, day: text(bucket.day), provider: text(bucket.provider), model: text(bucket.model), costUsd: finite(bucket.costUsd), cacheSavingsUsd: finite(bucket.cacheSavingsUsd), fastCostUsd: finite(bucket.fastCostUsd), ultrafastCostUsd: finite(bucket.ultrafastCostUsd), speedPremiumUsd: finite(bucket.speedPremiumUsd), uncachedInputTokens: finite(totals.uncachedInputTokens), cachedInputTokens: finite(totals.cachedInputTokens), cacheCreationTokens: finite(totals.cacheCreationTokens), outputTokens: finite(totals.outputTokens) };
  });
  let sessions = 0;
  let refreshing = false;
  const issues: string[] = [];
  const sessionsByProvider: Record<string, number> = {};
  for (const source of value.sources) {
    if (!record(source)) continue;
    sessions += finite(source.distinctSessions);
    if (record(source.fingerprint) && text(source.fingerprint.provider)) {
      const provider = text(source.fingerprint.provider);
      sessionsByProvider[provider] = (sessionsByProvider[provider] ?? 0) + finite(source.distinctSessions);
    }
    if (source.refreshing === true) refreshing = true;
    if (source.status === "failed" || source.status === "partial") issues.push(text(source.message) || `A usage source reported ${text(source.status)} results.`);
  }
  return { buckets, sessions, issues, unpricedRecords, refreshing, sessionsByProvider, pricingStatus: record(value.pricing) ? text(value.pricing.status) : "" };
}

export function usageWindow(days: number, now = new Date()) {
  const untilDay = now.toISOString().slice(0, 10);
  const sinceDay = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const range: { sinceDay: string; untilDay: string; timeZone: string; resolution: "day" | "hour"; sinceTime?: string; untilTime?: string } = { sinceDay, untilDay, timeZone: "UTC", resolution: days === 1 ? "hour" : "day" };
  if (days === 1) {
    range.sinceTime = new Date(now.getTime() - 86_400_000).toISOString();
    range.untilTime = now.toISOString();
    range.sinceDay = range.sinceTime.slice(0, 10);
  }
  return range;
}

export interface UsageLimitWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string;
  windowDurationMins: number | null;
  /** ServerProviderUsageWindow.kind: session, weekly, monthly or other. */
  kind?: string;
}

export interface UsageLimitAccount {
  id: string;
  driver: string;
  label: string;
  windows: UsageLimitWindow[];
  unavailable: string;
  /** ChatGPT-style banked reset credits (ServerProviderResetCredits); null when the account has none. */
  resetCredits: { availableCount: number; nextExpiresAt: string; /** A hub account's next credit, which a redemption names. */ nextCreditId?: string } | null;
  /** Where usage is tracked outside the app (ServerProviderUsageLimits.externalUsage). */
  externalUsage: { label: string; url: string } | null;
  /** The environment that reported the account (set by the page), for calls that must reach that server. */
  environmentId?: string;
  environmentLabel?: string;
  /** A hub account (a usage limit source such as CLIProxy): the source's id and label, and the account's own id. */
  sourceId?: string;
  sourceLabel?: string;
  hubAccountId?: string;
  /** ServerProvider.displayName, the signed-in email and plan label, the accent and the checked time. */
  displayName?: string | null;
  email?: string;
  plan?: string;
  accentColor?: string;
  workspaceId?: string;
  checkedAt?: string;
  /** ServerProviderUsageLimits.unavailable.reason: unsupported or probeFailed. */
  unavailableReason?: string;
  /** The server's own message, empty when it sent none (`unavailable` falls back to "Limits unavailable"). */
  unavailableMessage?: string;
  credentialFingerprint?: string;
  authenticated?: boolean;
}

/**
 * The accounts a provider list reports (ServerProvider.usageLimits). A reply that is malformed throws; with `lenient`
 * (the live config the page reads at once) a malformed provider or window is skipped so one bad record never blanks the page.
 */
export function parseUsageLimits(value: unknown, lenient = false): UsageLimitAccount[] {
  if (!record(value) || !Array.isArray(value.providers)) {
    throw new Error("The server returned invalid provider limits.");
  }
  const accounts: UsageLimitAccount[] = [];
  for (const provider of value.providers) {
    if (!record(provider) || !record(provider.usageLimits)) continue;
    const limits = provider.usageLimits;
    if (!text(provider.instanceId)) {
      if (lenient) continue;
      throw new Error("The server returned a provider without an identity.");
    }
    if (!Array.isArray(limits.windows)) {
      if (lenient) continue;
      throw new Error("The server returned invalid provider limits.");
    }
    const windows = limits.windows.flatMap((window) => {
      if (!record(window) || !text(window.id) || !text(window.label) || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) {
        if (lenient) return [];
        throw new Error("The server returned an invalid usage limit.");
      }
      return [{ id: text(window.id), label: text(window.label), usedPercent: window.usedPercent, resetsAt: text(window.resetsAt), windowDurationMins: typeof window.windowDurationMins === "number" && Number.isFinite(window.windowDurationMins) ? window.windowDurationMins : null, kind: text(window.kind) || "other" }];
    });
    accounts.push({
      id: text(provider.instanceId), driver: text(provider.driver), label: text(provider.displayName) || text(provider.driver) || text(provider.instanceId), windows,
      unavailable: record(limits.unavailable) ? text(limits.unavailable.message) || "Limits unavailable" : "",
      ...(record(limits.unavailable) && text(limits.unavailable.message) ? { unavailableMessage: text(limits.unavailable.message) } : {}),
      ...(record(limits.unavailable) && text(limits.unavailable.reason) ? { unavailableReason: text(limits.unavailable.reason) } : {}),
      displayName: text(provider.displayName).trim() || null,
      ...(record(provider.auth) && text(provider.auth.email) ? { email: text(provider.auth.email) } : {}),
      ...(record(provider.auth) && text(provider.auth.label) ? { plan: text(provider.auth.label) } : {}),
      ...(record(provider.auth) && text(provider.auth.workspaceId) ? { workspaceId: text(provider.auth.workspaceId) } : {}),
      authenticated: record(provider.auth) ? provider.auth.status === "authenticated" : false,
      ...(text(provider.accentColor) ? { accentColor: text(provider.accentColor) } : {}),
      ...(text(limits.checkedAt) ? { checkedAt: text(limits.checkedAt) } : {}),
      ...(text(limits.credentialFingerprint) ? { credentialFingerprint: text(limits.credentialFingerprint) } : {}),
      resetCredits: record(limits.resetCredits) && typeof limits.resetCredits.availableCount === "number"
        ? { availableCount: limits.resetCredits.availableCount, nextExpiresAt: text(limits.resetCredits.nextExpiresAt) } : null,
      externalUsage: record(limits.externalUsage) && text(limits.externalUsage.url) ? { label: text(limits.externalUsage.label), url: text(limits.externalUsage.url) } : null,
    });
  }
  return accounts;
}


/** A usage limit source (UsageLimitSourceSnapshot): a hub that reports limits for accounts of its own. */
export interface UsageLimitSource { id: string; label: string; error: string; accounts: UsageLimitAccount[] }

/** The hub accounts a config stream reports: each source with its accounts (UsageLimitSourceAccount), a malformed one skipped. */
export function parseUsageLimitSources(value: unknown): UsageLimitSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): UsageLimitSource[] => {
    if (!record(entry) || !text(entry.id) || !text(entry.label)) return [];
    const accounts = (Array.isArray(entry.accounts) ? entry.accounts : []).flatMap((item): UsageLimitAccount[] => {
      if (!record(item) || !text(item.id) || !record(item.usageLimits) || !Array.isArray(item.usageLimits.windows)) return [];
      const limits = item.usageLimits;
      const windows = (limits.windows as unknown[]).flatMap((window) => {
        if (!record(window) || !text(window.id) || !text(window.label) || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) return [];
        return [{ id: text(window.id), label: text(window.label), usedPercent: Math.max(0, Math.min(100, window.usedPercent)), resetsAt: text(window.resetsAt), windowDurationMins: typeof window.windowDurationMins === "number" && Number.isFinite(window.windowDurationMins) ? window.windowDurationMins : null, kind: text(window.kind) || "other" }];
      });
      const credits = record(limits.resetCredits) && typeof limits.resetCredits.availableCount === "number"
        ? { availableCount: limits.resetCredits.availableCount, nextExpiresAt: text(limits.resetCredits.nextExpiresAt), ...(text(limits.resetCredits.nextCreditId) ? { nextCreditId: text(limits.resetCredits.nextCreditId) } : {}) } : null;
      const unavailable = record(limits.unavailable) ? limits.unavailable : null;
      return [{
        id: `${text(entry.id)}:${text(item.id)}${text(item.workspaceId) ? `:${text(item.workspaceId)}` : ""}`, driver: text(item.driver), label: text(item.email) || text(item.id).replace(/\.json$/iu, ""), windows,
        unavailable: unavailable ? text(unavailable.message) || "Limits unavailable" : "", ...(unavailable && text(unavailable.reason) ? { unavailableReason: text(unavailable.reason) } : {}), ...(unavailable && text(unavailable.message) ? { unavailableMessage: text(unavailable.message) } : {}),
        resetCredits: credits, externalUsage: record(limits.externalUsage) && text(limits.externalUsage.url) ? { label: text(limits.externalUsage.label), url: text(limits.externalUsage.url) } : null,
        displayName: text(item.email) ? null : text(item.id).replace(/\.json$/iu, ""), ...(text(item.email) ? { email: text(item.email) } : {}), ...(text(item.plan) ? { plan: text(item.plan) } : {}), ...(text(item.workspaceId) ? { workspaceId: text(item.workspaceId) } : {}),
        ...(text(limits.checkedAt) ? { checkedAt: text(limits.checkedAt) } : {}), ...(text(limits.credentialFingerprint) ? { credentialFingerprint: text(limits.credentialFingerprint) } : {}),
        sourceId: text(entry.id), sourceLabel: text(entry.label), hubAccountId: text(item.id), authenticated: true,
      }];
    });
    return [{ id: text(entry.id), label: text(entry.label), error: text(entry.error), accounts }];
  });
}
