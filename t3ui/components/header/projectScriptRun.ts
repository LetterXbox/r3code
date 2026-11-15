// Running a project script (useChatTerminalActions.runProjectScript): the terminal
// drawer opens on a new terminal in the thread's folder and the script's command is
// typed into it once the session is up, with a leading space so it stays out of
// shell history. Saving goes to the project's `scripts` through `projects.mutate`.
import { requestBackend, threadById } from "../../store";
import { rememberInvokedScript } from "./lastInvokedScript";
import { replaceServerSettings, serverSettings } from "../../pages/settings/settingsState";
import { projectScriptsPatch } from "./scriptSettings";
import { drawerStateFor, updateDrawer } from "../terminal/drawerState";
import { queueTerminalInput, queueTerminalLaunch } from "../terminal/pendingInput";
import { activateTerminal, newTerminal } from "../terminal/terminalLogic";
import { hasTerminalSession, runningTerminalIds } from "../terminal/terminalSessionInfo";
import { showToast } from "../toast/toastState";
import { currentPanelKey, currentWorkspace, openBrowserAction, updatePanel } from "../rightPanel/panelState";
import { projectScriptTerminalInput, scriptPreviewToOpen, type ProjectScript } from "./projectScripts";

/** projectScriptTerminal.ts findReusableProjectScriptTerminal: an idle drawer terminal, the active one first. */
export function findReusableProjectScriptTerminal(input: { drawerTerminalIds: readonly string[]; activeTerminalId: string | null; runningTerminalIds: readonly string[] }): string | null {
  const idle = input.drawerTerminalIds.filter((terminalId) => !input.runningTerminalIds.includes(terminalId));
  if (input.activeTerminalId && idle.includes(input.activeTerminalId)) return input.activeTerminalId;
  return idle[0] ?? null;
}

/** useChatTerminalActions runProjectScript input: `preserve` types the command as is (a chat code block stays in shell
 * history); a script is typed with a leading space so it stays out of it. */
export function scriptTerminalInput(command: string, shellHistory: "preserve" | "suppress" = "suppress"): string {
  return shellHistory === "preserve" ? `${command}\r` : projectScriptTerminalInput(command);
}

export function runProjectScript(script: ProjectScript, options?: { rememberAsLastInvoked?: boolean; preferNewTerminal?: boolean; shellHistory?: "preserve" | "suppress"; env?: Record<string, string> }): boolean {
  const key = currentPanelKey();
  const space = currentWorkspace();
  if (!key || !space || !space.cwd) return false;
  const projectId = threadById(space.threadId)?.projectId;
  if (projectId && options?.rememberAsLastInvoked !== false) rememberInvokedScript(projectId, script.id);
  updatePanel(key, (state) => ({ ...state, terminalOpen: true }));
  // useChatTerminalActions: a settled drawer terminal is reused unless the script stops on settle or asks for a new one.
  const drawer = drawerStateFor(key);
  const reusable = script.stopOnSettle || options?.preferNewTerminal ? null : findReusableProjectScriptTerminal({
    drawerTerminalIds: drawer.groups.flatMap((group) => group.terminalIds).filter((terminalId) => hasTerminalSession(space.threadId, terminalId)),
    activeTerminalId: drawer.activeTerminalId ?? null,
    runningTerminalIds: runningTerminalIds(space.threadId),
  });
  const input = scriptTerminalInput(script.command, options?.shellHistory);
  if (reusable) {
    updateDrawer(key, (state) => activateTerminal(state, reusable));
    void requestBackend("terminal.write", { threadId: space.threadId, terminalId: reusable, data: input }).catch((cause: unknown) => {
      showToast({ type: "error", title: cause instanceof Error && cause.message ? cause.message : `Failed to run script "${script.name}".` });
    });
  } else {
    updateDrawer(key, newTerminal);
    const terminalId = drawerStateFor(key).activeTerminalId;
    if (!terminalId) return false;
    // terminal.open carries stopOnSettle and the caller's extra env (extraEnv) for a new terminal.
    if (script.stopOnSettle || options?.env) queueTerminalLaunch(space.threadId, terminalId, { ...(script.stopOnSettle ? { stopOnSettle: true } : {}), ...(options?.env ? { env: options.env } : {}) });
    queueTerminalInput(space.threadId, terminalId, input);
  }
  const preview = scriptPreviewToOpen(script);
  if (preview) openBrowserAction(preview);
  return true;
}

export async function saveProjectScripts(projectId: string, scripts: readonly ProjectScript[], request: (method: string, payload: unknown) => Promise<unknown> = requestBackend): Promise<void> {
  // With the server's settings known, the scripts are the project's settings override (useProjectScriptSettings.ts).
  const settings = serverSettings();
  if (settings) {
    replaceServerSettings(await request("server.updateSettings", { patch: projectScriptsPatch(settings, projectId, scripts) }));
    return;
  }
  await request("projects.mutate", { type: "project.update", commandId: `command:${crypto.randomUUID()}`, projectId, scripts });
}
