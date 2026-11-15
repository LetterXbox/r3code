// TextGeneratorsSettings.tsx / textGenerators.ts: model APIs that only write text, kept in
// settings.textGenerators and sharing the provider-instance id namespace.
import { DRIVERS } from "./driverMeta";
import { rec } from "./logic";

export type TextGeneratorKind = "openaiCompatible" | "anthropic";
export interface TextGeneratorPreset { id: string; label: string; kind: TextGeneratorKind; baseUrl: string }
export interface TextGenerator { id: string; kind: TextGeneratorKind; label?: string; baseUrl: string; apiKey: unknown; enabled: boolean }

export const TEXT_GENERATOR_PRESETS: TextGeneratorPreset[] = [
  { id: "openai", label: "OpenAI", kind: "openaiCompatible", baseUrl: "https://api.openai.com/v1" },
  { id: "openrouter", label: "OpenRouter", kind: "openaiCompatible", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "anthropic", label: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
  { id: "custom", label: "Custom (OpenAI-compatible)", kind: "openaiCompatible", baseUrl: "" },
];

export function readTextGenerators(raw: unknown): TextGenerator[] {
  const out: TextGenerator[] = [];
  for (const [id, value] of Object.entries(rec(raw) ?? {})) {
    const item = rec(value);
    if (!item || typeof item.baseUrl !== "string" || (item.kind !== "openaiCompatible" && item.kind !== "anthropic")) continue;
    out.push({ id, kind: item.kind, ...(typeof item.label === "string" && item.label ? { label: item.label } : {}), baseUrl: item.baseUrl, apiKey: item.apiKey, enabled: item.enabled !== false });
  }
  return out;
}

export function textGeneratorDisplayName(config: Pick<TextGenerator, "label" | "baseUrl" | "kind">): string {
  if (config.label) return config.label;
  const preset = TEXT_GENERATOR_PRESETS.find((candidate) => candidate.baseUrl === config.baseUrl && candidate.kind === config.kind);
  if (preset) return preset.label;
  try { return new URL(config.baseUrl).host; } catch { return config.baseUrl; }
}

/** A new id that matches no provider instance, driver default, provider or other text generator. */
export function nextTextGeneratorId(base: string, taken: Iterable<string>): string {
  const used = new Set<string>([...taken, ...DRIVERS.map((meta) => meta.driver)]);
  let id = base;
  for (let suffix = 2; used.has(id); suffix += 1) id = `${base}-${suffix}`;
  return id;
}

/** The base URL rule of the contract: http(s), no credentials, query or fragment, at most 2048 characters. */
export function validBaseUrl(value: string): boolean {
  const text = value.trim();
  if (text.length === 0 || text.length > 2048) return false;
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** The service a text generator reaches, which picks its icon (textGeneratorBrand). */
export function textGeneratorBrand(config: Pick<TextGenerator, "kind" | "baseUrl">): "anthropic" | "openrouter" | "openai" | "ollama" | "openaiCompatible" {
  if (config.kind === "anthropic") return "anthropic";
  let url: URL | null = null;
  try { url = new URL(config.baseUrl); } catch { /* an unparseable URL has no brand */ }
  const host = url?.hostname ?? "";
  if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) return "openrouter";
  if (host === "api.openai.com") return "openai";
  if (url?.port === "11434" || host.includes("ollama")) return "ollama";
  return "openaiCompatible";
}

/** Text tasks a generator can write, in the order the settings pages show them. */
export const TEXT_TASKS = [
  { key: "textGenerationModelSelection", label: "Thread titles and other generated text" },
  { key: "sourceControlWriterModelSelection", label: "Commit messages, pull requests, and branch names" },
  { key: "speechPostProcessingModelSelection", label: "Voice transcript cleanup" },
] as const;
export type TextTaskKey = (typeof TEXT_TASKS)[number]["key"];

export interface ModelSelectionValue { instanceId: string; model: string }
export function readSelection(value: unknown): ModelSelectionValue | null {
  const item = rec(value);
  return item && typeof item.instanceId === "string" && typeof item.model === "string" ? { instanceId: item.instanceId, model: item.model } : null;
}
/** Source control and voice follow the text generation model until they get their own. */
export function taskSelection(settings: Record<string, unknown>, key: TextTaskKey): { own: ModelSelectionValue | null; selection: ModelSelectionValue | null } {
  const own = readSelection(settings[key]);
  return { own, selection: own ?? readSelection(settings.textGenerationModelSelection) };
}

/** Searchable models: a search field only shows past eight, and matches the id or the name. */
export function filterGeneratorModels<T extends { id: string; name: string }>(models: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  return needle ? models.filter((model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle)) : [...models];
}

export interface TargetModel { provider: string; model: string; label: string; driver: string }
/**
 * The pickers' choices: text generation providers plus enabled text generators, which replace a provider
 * instance with the same id. A selection keeps its model while the generator's list loads (useTextGenerationTargets).
 */
export function textGenerationTargets(
  providers: ReadonlyArray<{ instanceId: string; driver: string; displayName: string | null; enabled: boolean; supportsTextGeneration?: boolean; models: { slug: string; name: string }[] }>,
  generators: readonly TextGenerator[],
  generatorModels: Readonly<Record<string, { id: string; name: string }[]>>,
  selections: readonly (ModelSelectionValue | null)[],
  providerLabel: (driver: string, displayName: string | null) => string,
): TargetModel[] {
  const own = new Set(generators.map((generator) => generator.id));
  const out: TargetModel[] = [];
  for (const provider of providers) {
    if (!provider.enabled || provider.supportsTextGeneration === false || own.has(provider.instanceId)) continue;
    const label = providerLabel(provider.driver, provider.displayName);
    for (const model of provider.models) out.push({ provider: provider.instanceId, model: model.slug, label: `${label}: ${model.name}`, driver: provider.driver });
  }
  for (const generator of generators.filter((item) => item.enabled)) {
    const label = textGeneratorDisplayName(generator);
    const listed = generatorModels[generator.id] ?? [];
    const missing = [...new Set(selections.flatMap((selection) => selection?.instanceId === generator.id ? [selection.model] : []))].filter((slug) => !listed.some((model) => model.id === slug)).map((slug) => ({ id: slug, name: slug }));
    for (const model of [...listed, ...missing]) out.push({ provider: generator.id, model: model.id, label: `${label}: ${model.name}`, driver: textGeneratorBrand(generator) });
  }
  return out;
}
