// Environment and provider selection for the Usage page, plus the aggregation that makes
// "All environments" a real sum. Ported from UsagePage.tsx (UsageEnvironmentFilter,
// UsageProviderFilter), usagePagePreferences.ts and usagePriceForm.ts. Pure functions only.
import type { UsageBucket, UsageResult } from "../../pages/utility-data";
import { PROVIDERS, providerPresentation } from "./usageFormat";

export interface UsageEnvironmentEntry { id: string; label: string; connected: boolean }

/** null selects every environment, like the web's selectedEnvironmentIds. */
export type EnvironmentSelection = ReadonlySet<string> | null;

export function selectedEnvironments(envs: UsageEnvironmentEntry[], selection: EnvironmentSelection): UsageEnvironmentEntry[] {
  return selection === null ? envs : envs.filter((env) => selection.has(env.id));
}

export function environmentLabel(envs: UsageEnvironmentEntry[], selection: EnvironmentSelection): string {
  if (selection === null) return "All environments";
  const chosen = selectedEnvironments(envs, selection);
  return chosen.length === 1 ? chosen[0]!.label : `${chosen.length} environments`;
}

/** "All environments" toggles everything; a single toggle collapses back to null when all are on. */
export function toggleAllEnvironments(checked: boolean): EnvironmentSelection {
  return checked ? null : new Set();
}

export function toggleEnvironment(envs: UsageEnvironmentEntry[], selection: EnvironmentSelection, id: string, checked: boolean): EnvironmentSelection {
  const next = new Set(selectedEnvironments(envs, selection).map((env) => env.id));
  if (checked) next.add(id);
  else next.delete(id);
  return next.size === envs.length ? null : next;
}

export const PROVIDER_ORDER: string[] = PROVIDERS.map((provider) => provider.key);

export function providerFilterLabel(hidden: readonly string[]): string {
  const visible = PROVIDER_ORDER.filter((key) => !hidden.includes(key));
  if (visible.length === PROVIDER_ORDER.length) return "All providers";
  if (visible.length === 0) return "No providers";
  if (visible.length === 1) return providerPresentation(visible[0]!).label;
  return `${visible.length} providers`;
}

export function toggleAllProviders(checked: boolean): string[] {
  return checked ? [] : [...PROVIDER_ORDER];
}

export function toggleProvider(hidden: readonly string[], provider: string, checked: boolean): string[] {
  return PROVIDER_ORDER.filter((entry) => (entry === provider ? !checked : hidden.includes(entry)));
}

export function filterUsageByProviders(result: UsageResult, hidden: readonly string[]): UsageResult {
  if (hidden.length === 0) return result;
  const sessionsByProvider = Object.fromEntries(Object.entries(result.sessionsByProvider).filter(([key]) => !hidden.includes(key)));
  return {
    ...result,
    buckets: result.buckets.filter((bucket) => !hidden.includes(bucket.provider)),
    sessionsByProvider,
    sessions: Object.values(sessionsByProvider).reduce((sum, count) => sum + count, 0),
  };
}

function bucketKey(bucket: UsageBucket): string {
  return `${bucket.day}|${bucket.hourStart}|${bucket.provider}|${bucket.model}`;
}

function addCategory(a: UsageBucket["categoryCost"], b: UsageBucket["categoryCost"]): UsageBucket["categoryCost"] {
  if (!a || !b) return a ?? b;
  return { input: a.input + b.input, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output };
}

/** The sum of several environments' answers: equal buckets add, sessions and issues concatenate. */
export function mergeUsageResults(results: UsageResult[]): UsageResult {
  const merged = new Map<string, UsageBucket>();
  const sessionsByProvider: Record<string, number> = {};
  const issues: string[] = [];
  let sessions = 0;
  let unpricedRecords = 0;
  let refreshing = false;
  let pricingStatus = "";
  for (const result of results) {
    for (const bucket of result.buckets) {
      const key = bucketKey(bucket);
      const existing = merged.get(key);
      merged.set(key, existing ? {
        ...existing,
        sessions: existing.sessions + bucket.sessions,
        categoryCost: addCategory(existing.categoryCost, bucket.categoryCost),
        costUsd: existing.costUsd + bucket.costUsd,
        cacheSavingsUsd: existing.cacheSavingsUsd + bucket.cacheSavingsUsd,
        fastCostUsd: (existing.fastCostUsd ?? 0) + (bucket.fastCostUsd ?? 0),
        ultrafastCostUsd: (existing.ultrafastCostUsd ?? 0) + (bucket.ultrafastCostUsd ?? 0),
        speedPremiumUsd: (existing.speedPremiumUsd ?? 0) + (bucket.speedPremiumUsd ?? 0),
        uncachedInputTokens: existing.uncachedInputTokens + bucket.uncachedInputTokens,
        cachedInputTokens: existing.cachedInputTokens + bucket.cachedInputTokens,
        cacheCreationTokens: existing.cacheCreationTokens + bucket.cacheCreationTokens,
        outputTokens: existing.outputTokens + bucket.outputTokens,
      } : bucket);
    }
    for (const [provider, count] of Object.entries(result.sessionsByProvider)) sessionsByProvider[provider] = (sessionsByProvider[provider] ?? 0) + count;
    for (const issue of result.issues) if (!issues.includes(issue)) issues.push(issue);
    sessions += result.sessions;
    unpricedRecords += result.unpricedRecords;
    refreshing = refreshing || result.refreshing;
    if (result.pricingStatus === "unavailable" || !pricingStatus) pricingStatus = result.pricingStatus;
  }
  return { buckets: [...merged.values()], sessions, issues, unpricedRecords, refreshing, sessionsByProvider, pricingStatus };
}

// ---- Model prices (usagePriceForm.ts) ----

export const USAGE_PRICE_FIELDS = [
  { key: "inputCostPerMillionTokens", label: "Input", optional: false },
  { key: "outputCostPerMillionTokens", label: "Output", optional: false },
  { key: "cacheReadCostPerMillionTokens", label: "Cache read", optional: true },
  { key: "cacheWriteCostPerMillionTokens", label: "Cache write", optional: true },
] as const;

export type UsagePriceKey = (typeof USAGE_PRICE_FIELDS)[number]["key"];
export type UsagePrice = { inputCostPerMillionTokens: number; outputCostPerMillionTokens: number; cacheReadCostPerMillionTokens?: number; cacheWriteCostPerMillionTokens?: number };
export type UsagePriceForm = { model: string } & Record<UsagePriceKey, string>;

export function usagePriceForm(model = "", price?: UsagePrice): UsagePriceForm {
  return {
    model,
    inputCostPerMillionTokens: price?.inputCostPerMillionTokens.toString() ?? "",
    outputCostPerMillionTokens: price?.outputCostPerMillionTokens.toString() ?? "",
    cacheReadCostPerMillionTokens: price?.cacheReadCostPerMillionTokens?.toString() ?? "",
    cacheWriteCostPerMillionTokens: price?.cacheWriteCostPerMillionTokens?.toString() ?? "",
  };
}

/** Blank cache prices use the input rate; explicit zero means free. */
export function parseUsagePriceForm(form: UsagePriceForm): { model: string; price: UsagePrice } | null {
  const model = form.model.trim();
  if (model.length === 0) return null;
  const rates: Partial<Record<UsagePriceKey, number>> = {};
  for (const field of USAGE_PRICE_FIELDS) {
    const raw = form[field.key].trim().replace(",", ".");
    if (raw === "") {
      if (field.optional) continue;
      return null;
    }
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return null;
    rates[field.key] = value;
  }
  if (rates.inputCostPerMillionTokens === undefined || rates.outputCostPerMillionTokens === undefined) return null;
  return {
    model,
    price: {
      inputCostPerMillionTokens: rates.inputCostPerMillionTokens,
      outputCostPerMillionTokens: rates.outputCostPerMillionTokens,
      ...(rates.cacheReadCostPerMillionTokens === undefined ? {} : { cacheReadCostPerMillionTokens: rates.cacheReadCostPerMillionTokens }),
      ...(rates.cacheWriteCostPerMillionTokens === undefined ? {} : { cacheWriteCostPerMillionTokens: rates.cacheWriteCostPerMillionTokens }),
    },
  };
}

export interface PriceRow { id: string; isNew: boolean; removed: boolean; form: UsagePriceForm; alias: string }

/** The server's overrides and aliases as editable rows, models sorted. */
export function priceRowsFrom(prices: Record<string, UsagePrice>, aliases: Record<string, string>): PriceRow[] {
  const models = [...new Set([...Object.keys(prices), ...Object.keys(aliases)])].sort();
  return models.map((model) => ({ id: model, isNew: false, removed: false, form: usagePriceForm(model, prices[model]), alias: aliases[model] ?? "" }));
}

/**
 * The server settings patch for the edited rows: changed prices and aliases, `null` removing one.
 * Returns an error string when a row cannot be saved, or null patch when nothing changed.
 */
export function priceChangesPatch(
  original: PriceRow[], rows: PriceRow[],
): { patch: { usagePriceOverrides?: Record<string, UsagePrice | null>; usageModelAliases?: Record<string, string | null> } | null; error: string | null } {
  const before = new Map(original.map((row) => [row.id, row]));
  const prices: Record<string, UsagePrice | null> = {};
  const aliases: Record<string, string | null> = {};
  for (const row of rows) {
    const model = row.form.model.trim();
    const old = before.get(row.id);
    if (row.removed) {
      if (old) { prices[old.form.model] = null; if (old.alias) aliases[old.form.model] = null; }
      continue;
    }
    const blank = USAGE_PRICE_FIELDS.every((field) => row.form[field.key].trim() === "");
    const alias = row.alias.trim();
    if (!old && !model && blank && !alias) continue;
    if (!model) return { patch: null, error: "Enter a model ID" };
    if (!blank) {
      const parsed = parseUsagePriceForm(row.form);
      if (!parsed) return { patch: null, error: `Enter valid prices for ${model}` };
      const changed = !old || JSON.stringify(usagePriceForm(model, parsed.price)) !== JSON.stringify({ ...old.form, model });
      if (changed) prices[model] = parsed.price;
    } else if (old && !USAGE_PRICE_FIELDS.every((field) => old.form[field.key].trim() === "")) {
      prices[model] = null;
    }
    if (alias !== (old?.alias ?? "")) aliases[model] = alias || null;
  }
  const patch: { usagePriceOverrides?: Record<string, UsagePrice | null>; usageModelAliases?: Record<string, string | null> } = {};
  if (Object.keys(prices).length > 0) patch.usagePriceOverrides = prices;
  if (Object.keys(aliases).length > 0) patch.usageModelAliases = aliases;
  return { patch: Object.keys(patch).length > 0 ? patch : null, error: null };
}

// ---- Per-model dialog stats (usageBreakdown.ts) ----

export function cacheHitRate(model: { cached: number; uncached: number; cacheWrite: number }): number | null {
  const input = model.cached + model.uncached + model.cacheWrite;
  return input > 0 ? model.cached / input : null;
}

export function costPerMillionTokens(model: { costUsd: number; total: number }): number | null {
  return model.total > 0 && model.costUsd > 0 ? (model.costUsd / model.total) * 1_000_000 : null;
}


// ---- Prices across environments (usagePriceTable.ts, usagePriceTargets.ts) ----

/** One environment's prices and mappings: null where they could not be read, with the reason it cannot be changed. */
export interface UsagePriceTarget {
  id: string;
  label: string;
  prices: Readonly<Record<string, UsagePrice>> | null;
  aliases: Readonly<Record<string, string>> | null;
  unavailable: string | null;
}

/** `null` removes the model's custom price or mapping. */
export type UsagePriceChange = { model: string; price: UsagePrice | null } | { model: string; alias: string | null };

export interface UsagePriceDraft {
  id: string;
  model: string;
  isNew: boolean;
  /** Only the cells that were edited: the rest keep each environment's own rate. */
  values: Partial<Record<UsagePriceKey, string>>;
  /** Edited "Map to" model. Absent keeps each environment's mapping; blank removes it. */
  alias?: string;
  removed?: boolean;
}

export function isEmptyUsagePriceDraft(draft: UsagePriceDraft): boolean {
  return draft.isNew && draft.model.trim() === "" && (draft.alias ?? "").trim() === "" && Object.values(draft.values).every((value) => value.trim() === "");
}

/** isUsagePriceEdit: decimal and exponent edits and every deletion, including temporarily invalid values; saving validates. */
export function isUsagePriceEdit(previous: string, next: string): boolean {
  if (/^\s*(?:\d*[.,]?\d*|(?:\d+[.,]?\d*|[.,]\d+)e[+-]?\d*)\s*$/i.test(next)) return true;
  if (next.length >= previous.length) return false;
  let start = 0;
  while (start < next.length && next[start] === previous[start]) start++;
  return next.slice(start) === previous.slice(previous.length - (next.length - start));
}

const modelPrice = (target: UsagePriceTarget, model: string) => (target.prices && Object.hasOwn(target.prices, model) ? target.prices[model] : undefined);
const modelAlias = (target: UsagePriceTarget, model: string) => (target.aliases && Object.hasOwn(target.aliases, model) ? target.aliases[model] : undefined);

/** The Map to cell: the shared mapping, "Mixed" when environments differ, "Unavailable" where mappings cannot be read. */
export function usageAliasCell(targets: readonly UsagePriceTarget[], model: string): { value: string; placeholder: string } {
  if (targets.some((target) => target.aliases === null)) return { value: "", placeholder: "Unavailable" };
  const values = targets.map((target) => modelAlias(target, model) ?? "");
  if (values.some((value) => value !== values[0])) return { value: "", placeholder: "Mixed" };
  return { value: values[0] ?? "", placeholder: "None" };
}

/** A price cell: the shared rate, "Mixed" when environments differ (editing it sets them all), "Automatic" with none. */
export function usagePriceCell(targets: readonly UsagePriceTarget[], model: string, field: UsagePriceKey): { value: string; placeholder: string } {
  const optional = USAGE_PRICE_FIELDS.find((entry) => entry.key === field)!.optional;
  const values = targets.map((target) => (modelPrice(target, model) ? usagePriceForm(model, modelPrice(target, model))[field] : null));
  if (targets.some((target) => target.prices === null)) return { value: "", placeholder: "Unavailable" };
  if (values.some((value) => value !== values[0])) return { value: "", placeholder: "Mixed" };
  return { value: values[0] ?? "", placeholder: values[0] === null ? "Automatic" : optional ? "Input rate" : "0.00" };
}

/** What saving the drafts changes on one environment, and the rows that cannot be saved there. */
export function usagePriceTableChanges(target: UsagePriceTarget, drafts: readonly UsagePriceDraft[]): { changes: UsagePriceChange[]; errors: Map<string, string> } {
  const changes: UsagePriceChange[] = [];
  const errors = new Map<string, string>();
  for (const draft of drafts) {
    if (isEmptyUsagePriceDraft(draft)) continue;
    const model = draft.model.trim();
    const currentAlias = modelAlias(target, model);
    if (draft.removed) {
      if (modelPrice(target, model)) changes.push({ model, price: null });
      if (currentAlias !== undefined) changes.push({ model, alias: null });
      continue;
    }
    const alias = (draft.alias ?? currentAlias ?? "").trim();
    if (alias !== "") {
      if (draft.alias === undefined && Object.keys(draft.values).length > 0) { errors.set(draft.id, `${target.label} maps this model. Remove it from "Apply to" or clear its mapping first.`); continue; }
      if (model === "") errors.set(draft.id, "Enter a model ID.");
      else if (alias === model) errors.set(draft.id, "Map to a different model.");
      else {
        if (alias !== currentAlias) changes.push({ model, alias });
        if (modelPrice(target, model)) changes.push({ model, price: null });
      }
      continue;
    }
    if (currentAlias !== undefined) {
      changes.push({ model, alias: null });
      if (!modelPrice(target, model) && Object.values(draft.values).every((value) => value.trim() === "")) continue;
    }
    const original = usagePriceForm(model, modelPrice(target, model));
    const form = { ...original, ...draft.values } as UsagePriceForm;
    const parsed = parseUsagePriceForm(form);
    if (parsed === null) {
      const missing = USAGE_PRICE_FIELDS.find((field) => !field.optional && form[field.key].trim() === "");
      errors.set(draft.id, model === "" ? "Enter a model ID." : missing ? `${missing.label} is required on ${target.label}.` : "Use non-negative numbers for prices.");
      continue;
    }
    const next = usagePriceForm(model, parsed.price);
    if (USAGE_PRICE_FIELDS.some((field) => original[field.key] !== next[field.key])) changes.push(parsed);
  }
  // Check the final batch so clearing a mapping and reversing it in one save stays valid.
  const aliases = new Map(Object.entries(target.aliases ?? {}));
  for (const change of changes) {
    if (!("alias" in change)) continue;
    if (change.alias === null) aliases.delete(change.model); else aliases.set(change.model, change.alias);
  }
  for (const draft of drafts) {
    if (draft.removed || errors.has(draft.id)) continue;
    let model = draft.model.trim();
    const seen = new Set<string>();
    while (aliases.has(model)) {
      if (seen.has(model)) { errors.set(draft.id, `Model mappings cannot form a cycle on ${target.label}.`); break; }
      seen.add(model);
      model = aliases.get(model)!;
    }
  }
  return { changes, errors };
}

/** Errors across the environments that can be written, keyed by draft. */
export function usagePriceTableErrors(targets: readonly UsagePriceTarget[], drafts: readonly UsagePriceDraft[]): Map<string, string> {
  return new Map(targets.filter((target) => target.unavailable === null && target.prices !== null).flatMap((target) => [...usagePriceTableChanges(target, drafts).errors]));
}

/** The `server.updateSettings` patch for one environment's changes. */
export function usagePricePatch(changes: readonly UsagePriceChange[]): { usagePriceOverrides?: Record<string, UsagePrice | null>; usageModelAliases?: Record<string, string | null> } {
  const prices = changes.flatMap((change) => ("price" in change ? [[change.model, change.price] as const] : []));
  const aliases = changes.flatMap((change) => ("alias" in change ? [[change.model, change.alias] as const] : []));
  return { ...(prices.length > 0 ? { usagePriceOverrides: Object.fromEntries(prices) } : {}), ...(aliases.length > 0 ? { usageModelAliases: Object.fromEntries(aliases) } : {}) };
}

export type UsagePriceWriteResult = { status: "saved" } | { status: "failed"; error: string };

/** Destinations settle independently; a retry passes only the failures (writeUsagePrices). */
export async function writeUsagePrices(input: {
  targets: readonly UsagePriceTarget[];
  changes: ReadonlyMap<string, readonly UsagePriceChange[]>;
  write: (environmentId: string, patch: ReturnType<typeof usagePricePatch>) => Promise<void>;
  onResult: (environmentId: string, result: UsagePriceWriteResult) => void;
}): Promise<void> {
  await Promise.all(input.targets.map(async (target) => {
    let result: UsagePriceWriteResult;
    const changes = input.changes.get(target.id) ?? [];
    if (target.unavailable !== null) result = { status: "failed", error: target.unavailable };
    else if (changes.some((change) => "alias" in change) && target.aliases === null) result = { status: "failed", error: "Update server to map models" };
    else {
      try {
        if (changes.length > 0) await input.write(target.id, usagePricePatch(changes));
        result = { status: "saved" };
      } catch {
        result = { status: "failed", error: "Could not save. Try again." };
      }
    }
    input.onResult(target.id, result);
  }));
}
