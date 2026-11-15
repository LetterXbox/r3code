// Starred models, kept on the server as `settings.favorites` ([{ provider, model }]) and written
// with `server.updateSettings { patch: { setModelFavorites } }`, as useSettings.ts does. While no
// environment reports a list the stars live on this device (Storage) so they survive restarts.
import { signal, Storage } from "nsh";
import { requestServer } from "../../pages/settings/settingsSync";
import { replaceServerSettings, serverSettings } from "../../pages/settings/settingsState";
import { backendStatus } from "../../store";
import { modelKey } from "./modelPickerLogic";

const STORAGE_KEY = "modelFavorites";
const local = signal<ReadonlySet<string>>(new Set());
/** Optimistic stars while a write is in flight. */
const pending = signal<Record<string, boolean>>({});

let hydrated = false;
function hydrate() {
  if (hydrated) return;
  hydrated = true;
  void Storage.getItem(STORAGE_KEY).then((raw) => {
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) local.update((current) => new Set([...current, ...parsed.filter((item): item is string => typeof item === "string")]));
    } catch { /* a corrupt saved list is ignored */ }
  }).catch(() => {});
}

function serverList(): ReadonlySet<string> | null {
  const list = serverSettings()?.favorites;
  if (!Array.isArray(list) || backendStatus() !== "connected") return null;
  const out = new Set<string>();
  for (const item of list) {
    const entry = item as { provider?: unknown; model?: unknown };
    if (typeof entry?.provider === "string" && typeof entry?.model === "string") out.add(modelKey(entry.provider, entry.model));
  }
  return out;
}

/** The starred "provider:model" keys. */
export function favoriteKeys(): ReadonlySet<string> {
  hydrate();
  const next = new Set(serverList() ?? local());
  for (const [key, value] of Object.entries(pending())) {
    if (value) next.add(key); else next.delete(key);
  }
  return next;
}

export function toggleFavorite(provider: string, model: string) {
  const key = modelKey(provider, model);
  const favorite = !favoriteKeys().has(key);
  if (serverList() === null) {
    const next = new Set(local());
    if (favorite) next.add(key); else next.delete(key);
    local.set(next);
    void Storage.setItem(STORAGE_KEY, JSON.stringify([...next])).catch(() => {});
    return;
  }
  pending.update((all) => ({ ...all, [key]: favorite }));
  requestServer("server.updateSettings", { patch: { setModelFavorites: [{ provider, model, favorite }] } })
    .then(replaceServerSettings)
    .catch(() => {})
    .finally(() => pending.update((all) => { const { [key]: _done, ...rest } = all; return rest; }));
}
