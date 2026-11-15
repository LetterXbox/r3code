// The app-wide commands of DEFAULT_KEYBINDINGS that need nothing but the store,
// and the when-clause context the app can report. Modules that own a command's
// behaviour register it themselves (sidebarKeys.ts: thread.*, panelKeys.ts:
// rightPanel / threadPanel / diff, ThreadView: terminal.toggle, Usage: usage.*).
import { allProjects, closeSettings, closeUsage, createThread, isServerThread, openSettings, openThread, openUsage, paletteOpen, settingsOpen, toggleSidebar, togglePalette, usageOpen } from "../store";
import { appearanceMode, chooseAppearanceMode } from "../pages/settings/Appearance";
import { copyActiveThreadReference, openPaletteOn, toggleThemeEditor, togglePaletteMode } from "../components/palette/paletteModel";
import { threadUndo, unsettleThread } from "../components/sidebar/threadActions";
import { settleAndAdvance } from "../components/sidebar/settleAndAdvance";
import { resolveSection } from "../components/sidebar/threadStatus";
import { errorToast, showToast } from "../components/toast/toastState";
import { canOperatePreview } from "../components/rightPanel/previewScope";
import { closeRightPanelAction, currentPanelKey, currentWorkspace, openBrowserAction, panelStateFor, updatePanel } from "../components/rightPanel/panelState";
import { installClosedViews } from "./closedViews";
import { openFavoriteEditorAction, pressOpenFavoriteTarget } from "../components/header/openFavorite";
import { installFocusContexts } from "./focusContext";
import { openThreadFind } from "../components/thread/threadFindState";
import { defineContext, registerCommandFallback, registerCommands } from "./registry";
import { resolveProjectScripts } from "../components/header/scriptSettings";
import { runProjectScript } from "../components/header/projectScriptRun";
import { canLaunchTerminal } from "../components/terminal/terminalAllocation";
import { serverSettings } from "../pages/settings/settingsState";
import { startNewThreadFromSidebar } from "../components/sidebar/newThreadAction";

/** projectScriptIdFromCommand: the id inside `script.<id>.run`, else null. */
export function projectScriptIdFromCommand(command: string): string | null {
  const match = /^script\.([a-z0-9][a-z0-9-]{0,23})\.run$/.exec(command.trim());
  return match ? match[1]! : null;
}

/** ChatView's keybinding fallback: `script.<id>.run` runs the open thread's project script, when terminals may be started. */
export function projectScriptCommandHandler(command: string): (() => void) | undefined {
  const scriptId = projectScriptIdFromCommand(command);
  const thread = openThread();
  const project = thread ? allProjects().find((item) => item.id === thread.projectId) : undefined;
  if (!scriptId || !project || !canLaunchTerminal()) return undefined;
  const script = resolveProjectScripts(serverSettings(), { id: project.id, scripts: project.scripts ?? [] }).find((entry) => entry.id === scriptId);
  return script ? () => { runProjectScript(script); } : undefined;
}
import { selectedModel, setModelOptionSelections, stopThread, threadUserInputs } from "../store";
import { selectedDescriptors } from "../components/composer/providerCatalog";
import { replaceCurrentValue, selectionsFromDescriptors, stepReasoning } from "../components/composer/modelTraits";
import { applyThreadModelPick } from "../components/composer/threadModelPick";

/** composerShortcuts.ts composer.increaseEffort / decreaseEffort: one reasoning level up or down, not while a question waits. */
export function stepComposerEffort(direction: 1 | -1): boolean {
  const choice = selectedModel();
  if (paletteOpen() || !openThread() || !choice || threadUserInputs().length > 0) return false;
  const change = stepReasoning(selectedDescriptors(), direction);
  if (!change) return true;
  setModelOptionSelections(choice.provider, choice.model, selectionsFromDescriptors(replaceCurrentValue(selectedDescriptors(), change.id, change.value)));
  // ChatComposer: the stepped options apply to an existing thread at once (applyThreadModelPick).
  applyThreadModelPick(openThread()?.id, choice.provider, choice.model);
  return true;
}

/** chat.new: with several projects it asks which one (the palette's "New thread in..."), else starts in the current one. */
export function startNewThread() {
  startNewThreadFromSidebar();
}

/** chat.newWithoutProject: a scratch thread that belongs to no project. */
export function startThreadWithoutProject() {
  createThread(null);
}

const APPEARANCE_LABEL = { system: "System", light: "Light", dark: "Dark" } as const;

/** appearance.cycle: system, light, dark, system; a toast names the new mode (id appearance-cycle, 1.5 s). */
export function cycleAppearance() {
  const mode = appearanceMode();
  const next = mode === "system" ? "light" : mode === "light" ? "dark" : "system";
  chooseAppearanceMode(next);
  showToast({ id: "appearance-cycle", title: `Appearance: ${APPEARANCE_LABEL[next]}`, timeoutMs: 1500 });
}

/** thread.settle: settles the open thread and moves to the next card (settleAndAdvance), or brings it back when it is settled already. */
export function settleOpenThread(): boolean {
  const thread = openThread();
  if (!thread || !isServerThread(thread.id)) return false;
  const settled = resolveSection(thread, Date.now()) === "settled";
  void (settled ? unsettleThread(thread.id) : settleAndAdvance(thread.id)).catch((error: unknown) => {
    errorToast(settled ? "Failed to unsettle thread" : "Failed to settle thread", error instanceof Error ? error.message : "An error occurred.");
  });
  return true;
}

/** preview.toggle: the preview tab opens (a new browser when the panel has none) or, when it is the one showing, the panel closes. */
export function togglePreview() {
  const key = currentPanelKey();
  if (key === null) return false;
  const state = panelStateFor(key);
  const active = state.surfaces.find((surface) => surface.id === state.activeId);
  // chatRouteCommands.ts: without the preview operate scope the key is claimed and nothing happens, unless a preview is already open.
  if (!canOperatePreview() && !(state.open && state.surfaces.some((surface) => surface.kind === "preview"))) return true;
  if (state.open && active?.kind === "preview") { closeRightPanelAction(); return true; }
  const existing = state.surfaces.find((surface) => surface.kind === "preview");
  if (existing) updatePanel(key, (current) => ({ ...current, open: true, activeId: existing.id }));
  else openBrowserAction();
  return true;
}

/** Registers the commands and context. Call once at startup. */
export function installStandardCommands() {
  defineContext("usagePageOpen", () => usageOpen());
  defineContext("turnRunning", () => openThread()?.status === "running");
  defineContext("draftThreadRoute", () => { const thread = openThread(); return thread ? !isServerThread(thread.id) : false; });
  defineContext("terminalOpen", () => panelStateFor(currentPanelKey()).terminalOpen);
  defineContext("rightPanelOpen", () => panelStateFor(currentPanelKey()).open);
  installFocusContexts();

  const unlessPaletteOpen = (run: () => void) => () => { if (paletteOpen()) return false; run(); };
  registerCommands({
    "sidebar.toggle": toggleSidebar,
    "commandPalette.toggle": togglePalette,
    "usage.open": () => (usageOpen() ? closeUsage() : openUsage()),
    "chat.new": unlessPaletteOpen(startNewThread),
    "chat.newLocal": unlessPaletteOpen(() => startNewThreadFromSidebar(true)),
    "chat.newWithoutProject": unlessPaletteOpen(startThreadWithoutProject),
    "chat.find": () => { if (paletteOpen() || !openThread()) return false; openThreadFind(); },
    "appearance.cycle": cycleAppearance,
    "theme.select": () => { if (!paletteOpen()) openPaletteOn("theme"); },
    "filePicker.toggle": () => togglePaletteMode("files"),
    "projectSearch.toggle": () => togglePaletteMode("content"),
    "themeEditor.toggle": () => { if (!paletteOpen()) toggleThemeEditor(); },
    "thread.copyReference": () => { if (paletteOpen()) return false; return copyActiveThreadReference(); },
    "thread.settle": () => { if (paletteOpen()) return false; return settleOpenThread(); },
    // ChatView.tsx thread.stop: interrupts the open thread's running turn; unclaimed when nothing runs.
    "thread.stop": () => { if (paletteOpen() || openThread()?.status !== "running") return false; stopThread(); },
    "composer.increaseEffort": () => stepComposerEffort(1),
    "composer.decreaseEffort": () => stepComposerEffort(-1),
    "thread.undo": () => { if (paletteOpen() || !threadUndo.notice()) return false; void threadUndo.run(); },
    "preview.toggle": () => { if (paletteOpen()) return false; return togglePreview(); },
    "editor.openFavorite": () => {
      if (paletteOpen() || !currentWorkspace()?.cwd) return false;
      // The picker's primary button on screen is the target; without an enabled one the preferred editor opens directly.
      if (pressOpenFavoriteTarget()) return;
      void openFavoriteEditorAction().then((opened) => {
        if (!opened) showToast({ type: "info", title: "No editor to open the project in", description: "Install a supported editor on the machine the project is on." });
      }).catch((error: unknown) => errorToast("Unable to open in editor", error instanceof Error && error.message ? error.message : "An error occurred."));
    },
  });
  registerCommandFallback(projectScriptCommandHandler);
  installClosedViews();
  // workspace.focusNext / focusPrevious are registered by the first registerFocusArea (commands/workspaceFocus.ts),
  // so a bound key with no area never swallows F6.
}

/** `mod+,` is the desktop menu's Settings item, not a keybinding command. */
export function toggleSettings() {
  if (settingsOpen()) closeSettings();
  else openSettings();
}
