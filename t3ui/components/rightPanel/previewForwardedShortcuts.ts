// Forwarded shortcuts from the guest page (ReopenClosedViewShortcut.tsx setForwardedShortcuts + preview/Manager.ts
// before-input-event): app keydown listeners never see a key typed into the preview's page, so the app hands the page the
// chords of a few commands and the page answers with the command instead of taking the key. In the port the page's own
// keydown listener (injected before content loads) does what Electron's before-input-event does in the reference.
import { activeRules, hasCommandHandler, readContext, runCommand } from "../../commands/registry";
import { whenHolds } from "../../commands/whenClause";

/** ReopenClosedViewShortcut.tsx PREVIEW_FORWARDED_COMMANDS (view.reopenClosed joins while there is history to reopen). */
export const PREVIEW_FORWARDED_COMMANDS = ["workspace.focusNext", "workspace.focusPrevious", "sidebar.toggle", "rightPanel.toggle", "rightPanel.toggleMaximized", "preview.focusUrl"] as const;

export interface ForwardedShortcut { command: string; keystroke: string }

/** effectiveShortcutsForCommand with the reference's context: the preview has the focus, no terminal or field does. */
export function forwardedShortcuts(rules = activeRules(), context: Readonly<Record<string, boolean>> = readContext(), hasHistory = hasCommandHandler("view.reopenClosed")): ForwardedShortcut[] {
  const commands: string[] = [...(hasHistory ? ["view.reopenClosed"] : []), ...PREVIEW_FORWARDED_COMMANDS];
  const forwardedContext = { ...context, previewFocus: true, previewOpen: true, terminalFocus: false, terminalOpen: context.terminalOpen === true, editableFocus: false, modelPickerOpen: false, isDesktop: true, isWeb: false };
  const out: ForwardedShortcut[] = [];
  for (const command of commands) {
    // The newest rule on a keystroke wins (resolveCommand), so a chord another command took later is not this one's.
    for (const rule of rules) {
      if (rule.command !== command || !rule.keystroke || !whenHolds(rule.when, forwardedContext)) continue;
      const shadowed = rules.slice(rules.indexOf(rule) + 1).some((later) => later.keystroke === rule.keystroke && later.command !== command && whenHolds(later.when, forwardedContext));
      if (!shadowed && !out.some((item) => item.keystroke === rule.keystroke)) out.push({ command, keystroke: rule.keystroke });
    }
  }
  return out;
}

/** The page's keystroke for a keydown, in the registry's form (mod+shift+k, f6, alt+up); null for a lone modifier. */
export function pageKeystroke(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, isMac: boolean): string | null {
  const raw = event.key.toLowerCase();
  if (["meta", "control", "alt", "shift", "dead", "process", "unidentified", ""].includes(raw)) return null;
  const names: Record<string, string> = { arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right", esc: "escape", "=": "plus", "+": "plus", "-": "minus", " ": "space" };
  const mods: string[] = [];
  if (isMac ? event.metaKey : event.ctrlKey) mods.push("mod");
  if (isMac && event.ctrlKey) mods.push("ctrl");
  if (event.altKey) mods.push("alt");
  if (event.shiftKey) mods.push("shift");
  return [...mods, names[raw] ?? raw].join("+");
}

/** The page side: the chords live on window.__t3forwarded (updated in place), a match posts {t3:"shortcut", command}. */
export const FORWARDED_SHORTCUTS_PAGE_SOURCE = `(function(){var W=window;if(W.__t3forwardedInstalled)return;W.__t3forwardedInstalled=true;W.__t3forwarded=W.__t3forwarded||[];
var mac=/Mac/.test(navigator.platform);var N={arrowup:"up",arrowdown:"down",arrowleft:"left",arrowright:"right",esc:"escape","=":"plus","+":"plus","-":"minus"," ":"space"};
function ks(e){var k=(e.key||"").toLowerCase();if(["meta","control","alt","shift","dead","process","unidentified",""].indexOf(k)>=0)return null;var m=[];if(mac?e.metaKey:e.ctrlKey)m.push("mod");if(mac&&e.ctrlKey)m.push("ctrl");if(e.altKey)m.push("alt");if(e.shiftKey)m.push("shift");m.push(N[k]||k);return m.join("+")}
W.addEventListener("keydown",function(e){if(e.isComposing)return;var s=ks(e);if(!s)return;var list=W.__t3forwarded||[];for(var i=0;i<list.length;i++){if(list[i].keystroke===s){e.preventDefault();e.stopImmediatePropagation();try{W.nsh&&W.nsh.postMessage(JSON.stringify({t3:"shortcut",command:list[i].command}))}catch(x){}return}}},true)})();`;

/** The script that sets the page's chords (run at load and whenever the bindings change). */
export function forwardedShortcutsScript(shortcuts: readonly ForwardedShortcut[]): string {
  return `window.__t3forwarded=${JSON.stringify(shortcuts).replace(/</g, "\\u003c")};${FORWARDED_SHORTCUTS_PAGE_SOURCE}true;`;
}

/** The page's `{t3:"shortcut"}` message: runs the command it names when it is one the page was given. */
export function handleForwardedShortcutMessage(data: string, allowed: readonly ForwardedShortcut[] = forwardedShortcuts(), run: (command: string) => boolean = runCommand): boolean {
  let message: { t3?: unknown; command?: unknown };
  try { message = JSON.parse(data); } catch { return false; }
  if (message?.t3 !== "shortcut" || typeof message.command !== "string") return false;
  const command = message.command;
  if (!allowed.some((item) => item.command === command)) return true;
  run(command);
  return true;
}
