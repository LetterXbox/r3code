// KeybindingsUpdateToast.tsx, KeybindingsUpdateToast.logic.ts and KeybindingsConfigWarning.tsx: each keybindings reload the server
// reports raises a toast, "Keybindings updated", or "Invalid keybindings configuration" with the reason and an Open keybindings.json button.
import { Storage } from "nsh";
import { onServerConfigEvent, requestBackend } from "../store";
import { openInEditor } from "../components/header/gitRuntime";
import { effectiveEditor, readAvailableEditors } from "../components/header/openInLogic";
import { errorToast, showToast } from "../components/toast/toastState";

const COOLDOWN_MS = 2000;

export type KeybindingsToastDecision = { tag: "success" } | { tag: "invalid"; message: string };

function dict(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** createKeybindingsUpdateToastController: a save and the server's file watcher each publish the same snapshot, so an identical toast inside the cooldown is the same change twice. */
export function createKeybindingsToastController(now: () => number = () => Date.now()) {
  let last: { key: string; at: number } | null = null;
  return (event: unknown): KeybindingsToastDecision | null => {
    const value = dict(event);
    if (value?.type !== "keybindingsUpdated") return null;
    const issues = Array.isArray(dict(value.payload)?.issues) ? (dict(value.payload)!.issues as unknown[]) : [];
    const issue = issues.map(dict).find((entry) => typeof entry?.kind === "string" && entry.kind.startsWith("keybindings."));
    const decision: KeybindingsToastDecision = issue ? { tag: "invalid", message: typeof issue.message === "string" ? issue.message : "" } : { tag: "success" };
    const key = issue ? `invalid:${decision.tag === "invalid" ? decision.message : ""}` : "success";
    const time = now();
    if (last !== null && last.key === key && time - last.at < COOLDOWN_MS) return null;
    last = { key, at: time };
    return decision;
  };
}

/** KeybindingsConfigWarning's button: opens keybindings.json in the preferred editor. */
/** `fallback` is the description when the error has no message: the toast's "Unknown error opening file.", the settings page's "The keybindings file was not opened." (KeybindingsSettings.tsx:1370). */
export async function openKeybindingsFile(request: (method: string, payload: unknown) => Promise<unknown> = requestBackend, fallback = "Unknown error opening file."): Promise<void> {
  try {
    const config = await request("server.getConfig", {});
    const path = dict(config)?.keybindingsConfigPath;
    const last = await Storage.getItem("lastEditor").catch(() => null);
    const editor = effectiveEditor(last, readAvailableEditors(config));
    if (typeof path !== "string" || !editor) throw new Error("No editor is available to open the file.");
    await openInEditor(path, editor, request);
  } catch (error) {
    errorToast("Unable to open keybindings file", error instanceof Error && error.message ? error.message : fallback);
  }
}

/** Raises the toast of a decision; `canOpen` says whether the config file and an editor are known. */
export function showKeybindingsToast(decision: KeybindingsToastDecision, canOpen: boolean, open: () => void = () => { void openKeybindingsFile(); }) {
  if (decision.tag === "success") {
    showToast({ type: "success", title: "Keybindings updated", description: "Keybindings configuration reloaded successfully." });
    return;
  }
  showToast({
    type: "warning",
    title: "Invalid keybindings configuration",
    description: decision.message,
    actions: [{ label: "Open keybindings.json", run: open, variant: "outline", disabled: !canOpen }],
  });
}

let installed = false;

/** Follows the connected server's config stream for keybindings reloads. Once, at startup. */
export function installKeybindingsToasts() {
  if (installed) return;
  installed = true;
  const decide = createKeybindingsToastController();
  // The store's own config stream: a second `subscribeServerConfig` made the server send every config snapshot twice.
  onServerConfigEvent((event) => {
    const decision = decide(event);
    if (!decision) return;
    if (decision.tag === "success") { showKeybindingsToast(decision, true); return; }
    void requestBackend("server.getConfig", {}).then((config) => {
      showKeybindingsToast(decision, typeof dict(config)?.keybindingsConfigPath === "string" && readAvailableEditors(config).length > 0);
    }).catch(() => showKeybindingsToast(decision, false));
  });
}
