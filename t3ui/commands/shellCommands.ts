// The commands of DEFAULT_KEYBINDINGS that had no handler: preview.focusUrl / zoomIn / zoomOut / resetZoom (against
// components/rightPanel/previewControls.ts), pullRequest.copyNumber, and the two composer send commands, which the composer binds
// itself through `bindComposerSendCommands` (a handler registered here with nothing to run would still capture mod+enter).
import { Clipboard } from "nsh";
import { currentPanelKey, panelStateFor } from "../components/rightPanel/panelState";
import { focusPreviewUrl, previewResetZoom, previewZoomIn, previewZoomOut } from "../components/rightPanel/previewControls";
import type { Surface } from "../components/rightPanel/panelLogic";
import { errorToast, showToast } from "../components/toast/toastState";
import { paletteOpen } from "../store";
import { registerCommand, registerCommands } from "./registry";

/** The change request a surface shows, as the copy command reads it: "#123" and the host's short term (PR, MR). */
export function pullRequestReference(surface: Surface | undefined): { text: string; shortLabel: string } | null {
  if (!surface || surface.kind !== "pull-request" || typeof surface.number !== "number" || surface.number <= 0) return null;
  const shortLabel = /gitlab/i.test(surface.host ?? "") || /gitlab/i.test(surface.url ?? "") ? "MR" : "PR";
  return { text: `#${surface.number}`, shortLabel };
}

/** pullRequest.copyNumber: copies the open pull request tab's number, then says so ("PR number copied"). */
export async function copyPullRequestNumber(reference: { text: string; shortLabel: string }, write: (text: string) => Promise<void> = (text) => Clipboard.writeText(text)): Promise<void> {
  const label = `${reference.shortLabel} number`;
  try {
    await write(reference.text);
    showToast({ type: "success", title: `${label} copied` });
  } catch (error) {
    errorToast(`Failed to copy ${label}`, error instanceof Error ? error.message : undefined);
  }
}

function activePullRequestSurface(): Surface | undefined {
  const key = currentPanelKey();
  if (key === null) return undefined;
  const state = panelStateFor(key);
  return state.surfaces.find((surface) => surface.id === state.activeId);
}

export interface ComposerSendCommands {
  /** composer.sendBackground on a draft: starts the thread and keeps working in the background. */
  sendBackground(): void;
  /** composer.sendAndNewThread on a started thread: sends, then opens a new thread. */
  sendAndNewThread(): void;
}

/** The composer calls this once with the two actions; the commands exist only while it does. Returns the release. */
export function bindComposerSendCommands(actions: ComposerSendCommands): () => void {
  return registerCommands({
    "composer.sendBackground": () => { if (paletteOpen()) return false; actions.sendBackground(); },
    "composer.sendAndNewThread": () => { if (paletteOpen()) return false; actions.sendAndNewThread(); },
  });
}

/**
 * composer.pasteAsText (Edit > Paste as Text): the open composer inserts the clipboard's text and takes none of its files, as the web's
 * armed plain-text paste does. The command exists only while a composer is open; `insert` puts the text at the caret.
 */
export function bindComposerPasteAsText(insert: (text: string) => void): () => void {
  return registerCommand("composer.pasteAsText", () => {
    void Clipboard.readText().then((text) => { if (text.length > 0) insert(text); }, () => {});
  });
}

let installed = false;

export function installShellCommands() {
  if (installed) return;
  installed = true;
  registerCommands({
    "preview.focusUrl": () => (paletteOpen() ? false : focusPreviewUrl() ? undefined : false),
    "preview.zoomIn": () => (paletteOpen() ? false : previewZoomIn() ? undefined : false),
    "preview.zoomOut": () => (paletteOpen() ? false : previewZoomOut() ? undefined : false),
    "preview.resetZoom": () => (paletteOpen() ? false : previewResetZoom() ? undefined : false),
  });
  registerCommand("pullRequest.copyNumber", () => {
    if (paletteOpen()) return false;
    const reference = pullRequestReference(activePullRequestSurface());
    if (!reference) return false;
    void copyPullRequestNumber(reference);
  });
}
