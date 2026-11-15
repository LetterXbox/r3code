// Usage providers: the CLIProxyAPI hubs in settings.usageLimitSources (UsageProviderSettings.tsx and
// AddUsageLimitSourceDialog.logic.ts).
export interface UsageSource { id: string; label: string; url: string; enabled: boolean }

export function usageSources(raw: Record<string, unknown> | undefined): UsageSource[] {
  const out: UsageSource[] = [];
  for (const [id, value] of Object.entries(raw ?? {})) {
    if (typeof value !== "object" || value === null) continue;
    const source = value as Record<string, unknown>;
    if (typeof source.url !== "string") continue;
    const label = typeof source.label === "string" && source.label.trim() ? source.label.trim() : source.url;
    out.push({ id, label, url: source.url, enabled: source.enabled !== false });
  }
  return out;
}

/** A readable id from the hub's host that never collides with an existing hub, as settings merge by id. */
export function sourceIdFromUrl(url: string, sources: ReadonlyArray<{ id: string; url: string }>): string {
  const saved = sources.find((source) => source.url === url);
  if (saved) return saved.id;
  let host = url;
  try { host = new URL(url).host; } catch {}
  const slug = host.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
  const base = `cliproxy-${slug || "hub"}`;
  const taken = new Set(sources.map((source) => source.id));
  let id = base;
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}-${suffix}`;
  return id;
}
