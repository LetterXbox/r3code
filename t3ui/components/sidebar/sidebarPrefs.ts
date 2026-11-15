// Sidebar state that survives a restart: which folders are collapsed, which shelves are
// open, and how many settled rows are showing. The web keeps these in localStorage
// ("t3code:sidebar:settled-expanded", ...) and the ui-state store (projectExpandedById).
// Folder collapse itself lives in store.ts (toggleProject); this module mirrors it to Storage.
import { effect, signal, Storage } from "nsh";
import { allProjects, isCollapsed, toggleProject } from "../../store";

const KEY = "sidebar.prefs";
export const SETTLED_TAIL_INITIAL_COUNT = 10;
export const SETTLED_TAIL_PAGE_COUNT = 25;

interface Stored {
  settledExpanded: boolean;
  snoozedExpanded: boolean;
  workingExpanded?: boolean;
  collapsedProjects: string[];
}

const settledExpanded = signal(false);
const snoozedExpanded = signal(false);
// The reference keeps the Working shelf closed until opened; the owner wants it shown, so it starts open.
const workingExpanded = signal(true);
const settledCount = signal(SETTLED_TAIL_INITIAL_COUNT);
let storedCollapsed: string[] = [];
let ready = false;

export const settledShelfExpanded = () => settledExpanded();
export const snoozedShelfExpanded = () => snoozedExpanded();
export const settledVisibleCount = () => settledCount();
export const workingShelfExpanded = () => workingExpanded();
export const toggleWorkingShelf = () => workingExpanded.update((open) => !open);
export const toggleSettledShelf = () => settledExpanded.update((open) => !open);
export const toggleSnoozedShelf = () => snoozedExpanded.update((open) => !open);
export const showMoreSettled = () => settledCount.update((count) => count + SETTLED_TAIL_PAGE_COUNT);

/** Reads the saved state, applies it, then starts saving changes. Safe to await twice. */
let loading: Promise<void> | null = null;
export function loadSidebarPrefs(): Promise<void> {
  loading ??= (async () => {
    try {
      const raw = await Storage.getItem(KEY);
      const parsed = raw ? (JSON.parse(raw) as Partial<Stored>) : {};
      settledExpanded.set(parsed.settledExpanded === true);
      snoozedExpanded.set(parsed.snoozedExpanded === true);
      workingExpanded.set(parsed.workingExpanded !== false);
      storedCollapsed = Array.isArray(parsed.collapsedProjects)
        ? parsed.collapsedProjects.filter((id): id is string => typeof id === "string")
        : [];
      for (const id of storedCollapsed) if (!isCollapsed(id)) toggleProject(id);
    } catch {
      // A damaged value is the same as none: everything starts expanded.
    }
    ready = true;
    effect(() => {
      const projects = allProjects();
      const known = new Set(projects.map((project) => project.id));
      const nowCollapsed = projects.filter((project) => isCollapsed(project.id)).map((project) => project.id);
      // Keep ids for projects this environment has not loaded yet; they may belong to another one.
      const collapsedProjects = projects.length === 0
        ? storedCollapsed
        : [...storedCollapsed.filter((id) => !known.has(id)), ...nowCollapsed];
      const next: Stored = { settledExpanded: settledExpanded(), snoozedExpanded: snoozedExpanded(), workingExpanded: workingExpanded(), collapsedProjects };
      storedCollapsed = collapsedProjects;
      if (ready) void Storage.setItem(KEY, JSON.stringify(next)).catch(() => {});
    });
  })();
  return loading;
}

void loadSidebarPrefs();
