import { activeProjectId, allProjects, createThread, isProjectArchived, settingValue } from "../../store";
import { serverEnvironment } from "../../pages/settings/settingsState";
import { openPaletteOn } from "../palette/paletteModel";
import { projectPickerEntries } from "./projectGrouping";

/** Sidebar and keyboard shortcuts share T3's grouped-project choice. */
export function startNewThreadFromSidebar(forceCurrent = false) {
  const current = activeProjectId();
  const groups = projectPickerEntries(allProjects(), {
    environmentId: String(serverEnvironment()?.environmentId ?? ""),
    globalMode: settingValue("sidebarProjectGroupingMode"),
    overrides: settingValue("sidebarProjectGroupingOverrides"),
  }, current);
  const available = groups.filter((group) => group.members.some((project) => !isProjectArchived(project.id)));
  // No projects at all: nothing for the palette's project picker to offer, so start a draft outright.
  if (groups.length === 0) { createThread(null); return; }
  if ((forceCurrent || available.length === 1) && current !== null) createThread(current);
  else openPaletteOn("new-thread-in");
}
