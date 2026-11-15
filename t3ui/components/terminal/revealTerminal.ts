import { activateSurfaceTerminal, type PanelState } from "../rightPanel/panelLogic";
import { activateTerminal, allTerminalIds, reconcileDrawerTerminals, type TerminalDrawerState } from "./terminalLogic";

/** Select the running terminal in its existing surface, or make it visible in the drawer. */
export function revealTerminal(panel: PanelState, drawer: TerminalDrawerState, terminalId: string): { panel: PanelState; drawer: TerminalDrawerState } {
  const surface = panel.surfaces.find((item) => item.kind === "terminal" && item.terminalIds?.includes(terminalId));
  if (surface) return { panel: { ...activateSurfaceTerminal(panel, surface.id, terminalId), open: true }, drawer };
  const ids = allTerminalIds(drawer);
  const ensured = ids.includes(terminalId) ? drawer : reconcileDrawerTerminals(drawer, [...ids, terminalId]);
  return { panel: { ...panel, terminalOpen: true }, drawer: activateTerminal(ensured, terminalId) };
}
