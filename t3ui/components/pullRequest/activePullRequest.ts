// The pull request open on the Pull requests page, for the `pullRequest.copyNumber` command (mod+shift+k): the page keeps
// it current, and `copyActivePullRequestNumber()` is what the command registry calls (PullRequestDetailPanel's
// copyFromShortcut: copies `#<number>` and toasts "<PR|MR> number copied").
import { Clipboard, signal } from "nsh";
import { showToast } from "../toast";

export interface ActivePullRequest { number: number; provider: string; /** The pull request URL, for the palette's Copy PR link. */ url?: string }

const active = signal<ActivePullRequest | null>(null);

export const activePullRequest = () => active();
export function setActivePullRequest(next: ActivePullRequest | null): void { active.set(next); }

// useOpenPanelPullRequestUrl's detail URL for a right-panel pull request tab (by surface id), kept as its detail loads.
const panelUrls = new Map<string, string>();
export function rememberPanelPullRequestUrl(surfaceId: string, url: string): void { panelUrls.set(surfaceId, url); }
/** useOpenPanelPullRequestUrl: the loaded detail's URL, else the tab's own URL; null while neither is known. */
export function panelPullRequestUrl(surface: { id: string; url?: string }): string | null {
  return panelUrls.get(surface.id) ?? surface.url ?? null;
}

/** Copies the open pull request's `#number`; false (and nothing copied) when none is open. */
export async function copyActivePullRequestNumber(): Promise<boolean> {
  const current = active();
  if (!current) return false;
  const label = `${current.provider === "gitlab" ? "MR" : "PR"} number`;
  try {
    await Clipboard.writeText(`#${current.number}`);
    showToast({ type: "success", title: `${label} copied` });
    return true;
  } catch (cause) {
    showToast({ type: "error", title: `Failed to copy ${label}`, description: cause instanceof Error ? cause.message : "Could not write to the clipboard." });
    return false;
  }
}
