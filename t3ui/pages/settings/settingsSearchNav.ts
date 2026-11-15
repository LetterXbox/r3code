// Settings search navigation, ported from SettingsSidebarNav.tsx: a highlighted
// result moved with the arrow keys, Enter (or a press) opening the matched setting
// itself, and the target row revealed and highlighted in its panel.
import { signal } from "nsh";
import type { InputRef, ScrollRef, ViewRef } from "nsh";
import { openSettings, setSettingsLanding, setSettingsSearchQuery, updateSetting, type SettingsSearchHit } from "../../store";

const active = signal(0);
/** Index of the highlighted search result (clamped by `clampActive`). */
export const activeResultIndex = () => active();
export function setActiveResultIndex(index: number) { active.set(index); }

/** The highlight stays inside the results; with none it rests on the first. */
export function clampActive(count: number): number {
  return Math.min(Math.max(active(), 0), Math.max(count - 1, 0));
}

/** ArrowDown / ArrowUp wrap around the results, as the web's nav does. */
export function stepActive(delta: 1 | -1, count: number) {
  if (count === 0) return;
  active.set((clampActive(count) + delta + count) % count);
}

/**
 * Targets the page draws inside another row. The reference anchors each one; here a result for
 * the microphone test or a model test lands on the row that holds it.
 */
const TARGET_ALIASES: Record<string, string> = {
  "/settings/voice\u0000microphone-test": "voice-microphone",
  "/settings/voice\u0000speech-models": "voice-transcription-destination",
  "/settings/voice\u0000transcription-test": "voice-transcription-destination",
};
export const resolveSettingsTarget = (path: string, id: string) => TARGET_ALIASES[`${path}\u0000${id}`] ?? id;

/** The row a result opens, matching how the store builds its hit ids. */
export const rowTargetId = (path: string, id: string | null, title: string) => id ?? `${path}:${title}`;

export interface SettingsTarget { path: string; id: string }
const target = signal<SettingsTarget | null>(null);
/** The setting a search result opened; its row is revealed and highlighted. */
export const settingsTarget = () => target();

const rows = new Map<string, ViewRef>();
let scroll: ScrollRef | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;

const rowKey = (path: string, id: string) => `${path}\u0000${id}`;
/** Panel rows report themselves so a search result can scroll to one. */
export function registerSettingsRow(path: string, id: string, ref: ViewRef) { rows.set(rowKey(path, id), ref); }
export function registerSettingsScroll(ref: ScrollRef) { scroll = ref; }

let searchInput: InputRef | null = null;
export function registerSettingsSearchInput(ref: InputRef) { searchInput = ref; }
/** "/" and mod+f put the cursor in the search field. */
export function focusSettingsSearch() { searchInput?.focus(); }

export function clearSearch() {
  setSettingsSearchQuery("");
  active.set(0);
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let revealSerial = 0;

/** Scrolls the panel so the target's row sits near the top. Waits for the panel to lay out. */
export async function revealSettingsTarget(path: string, id: string) {
  const serial = ++revealSerial;
  for (let attempt = 0; attempt < 12; attempt++) {
    await wait(attempt === 0 ? 30 : 60);
    if (serial !== revealSerial) return;
    const row = rows.get(rowKey(path, id));
    if (!row || !scroll) continue;
    scroll.scrollTo({ y: 0, animated: false });
    await wait(16);
    const [rowBox, viewport] = await Promise.all([row.measure(), scroll.measure()]);
    if (serial !== revealSerial) return;
    if (!rowBox || !viewport) continue;
    scroll.scrollTo({ y: Math.max(0, rowBox.pagePosition.y - viewport.pagePosition.y - 80), animated: true });
    return;
  }
}

/**
 * Opens what a search target lives in before jumping to it, so its row is mounted to scroll to
 * (`revealSettingsSearchTarget`). The prompt and terminal fonts exist only with separate fonts on.
 */
export function revealSettingsSearchTarget(targetId: string) {
  if (targetId === "prompt-font" || targetId === "terminal-font") updateSetting("typographyAdvanced", true);
}

/** Opens the setting a result names: its panel, then its row highlighted and revealed. */
export function openSettingsHit(hit: SettingsSearchHit) {
  clearSearch();
  openSettings(hit.path);
  if (hit.id.startsWith("section:")) { target.set(null); return; }
  const id = resolveSettingsTarget(hit.path, hit.targetId ?? hit.id);
  setSettingsLanding({ path: hit.path, targetId: hit.targetId ?? hit.id });
  revealSettingsSearchTarget(id);
  target.set({ path: hit.path, id });
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => target.set(null), 2500);
  void revealSettingsTarget(hit.path, id);
}

/** Navigating by the nav drops a stale highlight. */
export function clearSettingsTarget() {
  revealSerial++;
  setSettingsLanding(null);
  target.set(null);
}
