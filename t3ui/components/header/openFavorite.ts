// `editor.openFavorite` (mod+o): opens the thread's folder in the editor the
// details card last used, else the first installed one.
import { announce, platform, Storage } from "nsh";
import { requestBackend } from "../../store";
import { currentWorkspace } from "../rightPanel/panelState";
import { openThreadFolderInEditor } from "./remoteOpen.runtime";
import { editorLabel, effectiveEditor, readAvailableEditors } from "./openInLogic";

/**
 * OPEN_FAVORITE_EDITOR_ATTRIBUTE: the Open-in picker's primary button on screen marks itself as the target of `editor.openFavorite`, so the
 * shortcut opens exactly what the button would. The newest mounted one wins; a missing or disabled button leaves the chord to the direct
 * open below (registerOpenFavoriteEditorCommand returning false).
 */
const targets: { press: () => void; enabled: () => boolean }[] = [];
export function registerOpenFavoriteTarget(target: { press: () => void; enabled: () => boolean }): () => void {
  targets.push(target);
  return () => { const at = targets.indexOf(target); if (at >= 0) targets.splice(at, 1); };
}
/** Presses the on-screen button when there is an enabled one; true when it did. */
export function pressOpenFavoriteTarget(): boolean {
  const target = targets.at(-1);
  if (!target || !target.enabled()) return false;
  target.press();
  return true;
}

export async function openFavoriteEditorAction(request: (method: string, payload: unknown) => Promise<unknown> = requestBackend): Promise<boolean> {
  const cwd = currentWorkspace()?.cwd;
  if (!cwd) return false;
  const [config, last] = await Promise.all([request("server.getConfig", {}), Storage.getItem("lastEditor").catch(() => null)]);
  const editor = effectiveEditor(last, readAvailableEditors(config));
  if (!editor) return false;
  await openThreadFolderInEditor(cwd, editor, request);
  announce(`Opened in ${editorLabel(editor, platform.os)}`);
  return true;
}
