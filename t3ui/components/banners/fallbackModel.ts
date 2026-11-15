// packages/shared/src/usageLimits.ts exhaustedUsageWindow + resolveNewThreadModelSelection, and
// ComposerUsageLimits.tsx modelFallbackBannerItem: a new thread whose default model's provider is out of usage
// starts on the "Fallback model" setting instead, and the composer says so ("Using <fallback>").
// Pure: reads the server's raw provider snapshots (usageLimits.windows, enabled, installed, auth, availability).
import type { BannerItem } from "./bannerTypes";

export interface ModelChoice { instanceId: string; model: string }
type Raw = Record<string, unknown>;
interface UsageWindow { id: string; usedPercent?: number; resetsAt?: string }

const rec = (value: unknown): Raw | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : null);

function usageWindows(provider: Raw | undefined): UsageWindow[] {
  const windows = rec(provider?.usageLimits)?.windows;
  if (!Array.isArray(windows)) return [];
  return windows.map(rec).filter((item): item is Raw => item !== null && typeof item.id === "string").map((item) => ({
    id: item.id as string,
    ...(typeof item.usedPercent === "number" ? { usedPercent: item.usedPercent } : {}),
    ...(typeof item.resetsAt === "string" ? { resetsAt: item.resetsAt } : {}),
  }));
}

/** The first window at 100% that has not reset yet, by the driver's model pools (exhaustedUsageWindow). */
export function exhaustedUsageWindow(provider: Raw | undefined, now: number, model?: string): UsageWindow | undefined {
  const exhausted = usageWindows(provider).filter(
    (window) => (window.usedPercent ?? 0) >= 100 && (!window.resetsAt || !Number.isFinite(Date.parse(window.resetsAt)) || Date.parse(window.resetsAt) > now),
  );
  if (model === undefined) return exhausted[0];
  switch (provider?.driver) {
    case "cursor": {
      const api = exhausted.find((window) => window.id === "apiPercentUsed");
      const auto = exhausted.find((window) => window.id === "autoPercentUsed");
      return /^(auto|default|grok|composer)/.test(model) ? auto && api : api;
    }
    case "antigravity": {
      const family = model.match(/^(gemini|claude|gpt)-/)?.[1];
      return exhausted.find((window) => {
        const pool = window.id.match(/^(gemini|claude|gpt|3p)-/)?.[1];
        return pool === undefined || family === undefined || pool === family || (pool === "3p" && (family === "claude" || family === "gpt"));
      });
    }
    case "opencode":
      return exhausted.find((window) => !window.id.startsWith("go_") || model.startsWith("opencode-go/"));
    default:
      return exhausted[0];
  }
}

/** projectSettingsOverrides[projectId].providerInstances[instanceId].enabled === false turns a provider off for the project. */
function projectDisables(settings: Raw | null | undefined, projectId: string | null | undefined, instanceId: string): boolean {
  if (!projectId) return false;
  const override = rec(rec(rec(rec(settings?.projectSettingsOverrides)?.[projectId])?.providerInstances)?.[instanceId]);
  return override?.enabled === false;
}

export interface FallbackResolution { selection: ModelChoice | null; fallback: { provider: Raw; resetsAt: string | null } | null }

export function resolveNewThreadModelSelection(input: {
  defaultSelection: ModelChoice | null; explicitSelection?: ModelChoice | null; fallbackSelection: ModelChoice | null;
  providers: Raw[]; now: number; settings?: Raw | null; projectId?: string | null;
}): FallbackResolution {
  const selection = input.explicitSelection ?? input.defaultSelection;
  const unchanged = { selection, fallback: null };
  if (input.explicitSelection || !selection || !input.fallbackSelection) return unchanged;
  const provider = input.providers.find((entry) => entry.instanceId === selection.instanceId);
  const window = exhaustedUsageWindow(provider, input.now, selection.model);
  const fallback = input.providers.find((entry) => entry.instanceId === input.fallbackSelection?.instanceId);
  if (
    !provider || !window || !fallback || fallback.enabled === false || fallback.installed === false
    || rec(fallback.auth)?.status === "unauthenticated" || fallback.availability === "unavailable"
    || exhaustedUsageWindow(fallback, input.now, input.fallbackSelection.model)
    || projectDisables(input.settings, input.projectId, fallback.instanceId as string)
  ) return unchanged;
  return { selection: input.fallbackSelection, fallback: { provider, resetsAt: window.resetsAt ?? null } };
}

/** A stored ModelSelection ({ instanceId | provider, model }) as a choice. */
export function readChoice(value: unknown): ModelChoice | null {
  const selection = rec(value);
  const instanceId = typeof selection?.instanceId === "string" ? selection.instanceId : typeof selection?.provider === "string" ? selection.provider : null;
  return instanceId && typeof selection?.model === "string" ? { instanceId, model: selection.model } : null;
}

/** ChatView's dismissal key: the notice stays dismissed for this provider's current exhausted window only. */
export function fallbackWindowKey(fallback: NonNullable<FallbackResolution["fallback"]>): string {
  return `${String(fallback.provider.instanceId)}:${fallback.resetsAt ?? ""}`;
}

export function modelNameIn(provider: Raw | undefined, slug: string): string {
  const models = Array.isArray(provider?.models) ? provider.models.map(rec) : [];
  const found = models.find((item) => item?.slug === slug);
  return typeof found?.name === "string" ? found.name : slug;
}

/** modelFallbackBannerItem: info, gauge, "Using <fallback>", "<provider> is out of usage · resets <time>", "Use <default>". */
export function fallbackModelItem(input: {
  fallbackModelName: string; defaultProviderName: string; defaultModelName: string; resetsAt: string | null;
  formatUpcoming: (iso: string) => string; onUseDefault: () => void; onDismiss: () => void;
}): BannerItem {
  return {
    id: "fallback-model", variant: "info", icon: "gauge",
    title: `Using ${input.fallbackModelName}`,
    description: `${input.defaultProviderName} is out of usage${input.resetsAt ? ` · resets ${input.formatUpcoming(input.resetsAt)}` : ""}`,
    actions: [{ id: "use-default", label: `Use ${input.defaultModelName}`, tone: "button", run: input.onUseDefault }],
    dismissLabel: "Dismiss fallback model notice", onDismiss: input.onDismiss,
  };
}
