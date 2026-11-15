import { signal } from "nsh";
import { backendUrl, openSettings } from "../store";

const selectedProject = signal<{ id: string; endpoint: string } | null>(null);

/** Project IDs belong to an environment and must not follow a connection change. */
export function sidebarProjectSettingsId(): string | null {
  const selected = selectedProject();
  return selected && selected.endpoint === backendUrl() ? selected.id : null;
}

export function showSidebarProjectSettings(id: string) {
  selectedProject.set({ id, endpoint: backendUrl() });
  openSettings("/settings/projects");
}

export function clearSidebarProjectSettings() {
  selectedProject.set(null);
}
