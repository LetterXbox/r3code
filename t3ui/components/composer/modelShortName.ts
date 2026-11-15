// The composer trigger's model name (providerIconUtils getTriggerDisplayModelName ->
// provider-core modelShortName): "Claude Haiku 5.5" shows as "Haiku 5.5" and "GPT-6 Astra" as "6 Astra".
const FAMILY_PREFIXES = ["Claude ", "GPT-", "GPT ", "Gemini ", "Muse ", "Grok "];
const VARIANT_WORDS = new Set([
  "pro", "flash", "mini", "max", "lite", "nano", "ultra", "plus", "fast", "turbo", "preview", "latest", "thinking",
  "reasoning", "build", "code", "image", "vision", "audio", "live", "custom", "tools", "exp", "experimental", "chat",
  "tts", "stt", "non", "transcribe",
]);
const VERSION = /^v?\d+(?:\.\d+)*[a-z]?$/i;
const VENDOR_PREFIX = /^[A-Z][\w.&\- ]{0,24}: (?=\S)/;

const NATIVE_FAMILIES: Record<string, string[]> = {
  codex: ["GPT-", "GPT "],
  claudeAgent: ["Claude "],
  antigravity: ["Gemini "],
  cursor: ["Grok "],
  grok: ["Grok "],
  muse: ["Muse "],
};

function nonVersionWords(text: string): string[] {
  return text.replace(/\(.*?\)/g, " ").split(/[\s-]+/).filter((word) => word.length > 0 && !VERSION.test(word));
}
const namesModel = (text: string) => nonVersionWords(text).some((word) => !VARIANT_WORDS.has(word.toLowerCase()));

function withoutFamily(name: string, native: string[]): string | undefined {
  const prefix = FAMILY_PREFIXES.find((candidate) => name.startsWith(candidate));
  if (!prefix) return undefined;
  const rest = name.slice(prefix.length).trim();
  const keep = native.includes(prefix) ? nonVersionWords(rest).length > 0 : namesModel(rest);
  if (!keep) return undefined;
  return /\s/.test(rest) ? rest : rest.replaceAll("-", " ");
}

export function modelShortName(name: string, driver: string | null | undefined): string {
  const unprefixed = name.replace(VENDOR_PREFIX, "");
  const short = withoutFamily(unprefixed, (driver ? NATIVE_FAMILIES[driver] : undefined) ?? []) ?? (namesModel(unprefixed) ? unprefixed : name);
  return short;
}
