// rightPanelStore.ts:28,154: each pull-request tab remembers which detail tab (Summary / Guide / Timeline / Code) it
// showed, across remounts and restarts (persisted on this device, the web keeps it in the persisted panel store).
import { signal, Storage } from "nsh";
import type { DetailTab } from "./pullRequestDetailModel";

const KEY = "pullRequestDetailTabs:v1";
const TABS: readonly DetailTab[] = ["summary", "guide", "timeline", "code"];
const MAX = 200;
const remembered = signal<Record<string, DetailTab>>({});
let loaded = false;

void Storage.getItem(KEY).then((text) => {
  if (loaded || !text) return;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const valid = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, DetailTab] => TABS.includes(entry[1] as DetailTab)));
    remembered.set({ ...valid, ...remembered() });
  } catch { /* an unreadable copy is ignored */ }
}).catch(() => {}).finally(() => { loaded = true; });

export const rememberedPullRequestTab = (surfaceId: string): DetailTab | null => remembered()[surfaceId] ?? null;

export function rememberPullRequestTab(surfaceId: string, tab: DetailTab) {
  loaded = true;
  if (remembered()[surfaceId] === tab) return;
  const next = { ...remembered(), [surfaceId]: tab };
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX))) delete next[key];
  remembered.set(next);
  void Storage.setItem(KEY, JSON.stringify(next)).catch(() => {});
}
