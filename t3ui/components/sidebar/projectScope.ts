// "Filter threads by project": the sidebar lists only the chosen projects' threads while a
// scope is set (the web's projectScopeKeys). Empty means every project.
import { computed, signal, Storage } from "nsh";
import { allProjects, settingValue } from "../../store";
import { serverEnvironment } from "../../pages/settings/settingsState";
import { projectPickerEntries } from "./projectGrouping";

// uiStateStore.ts:436: the scope is remembered on this device across restarts.
const STORAGE_KEY = "sidebarProjectScope:v1";
const scope = signal<string[]>([]);
let scopeLoaded = false;
void Storage.getItem(STORAGE_KEY).then((text) => {
  if (scopeLoaded || !text) return;
  try { const parsed: unknown = JSON.parse(text); if (Array.isArray(parsed)) scope.set(parsed.filter((id): id is string => typeof id === "string")); } catch { /* ignored */ }
}).catch(() => {}).finally(() => { scopeLoaded = true; });
function write(next: string[]) {
  scopeLoaded = true;
  scope.set(next);
  void Storage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
}

/** Resolve selected logical projects against the current checkout list. */
export const projectScopeIds = computed(() => expandProjectScope(scope(), projectPickerEntries(allProjects(), {
  environmentId: String(serverEnvironment()?.environmentId ?? ""),
  globalMode: settingValue("sidebarProjectGroupingMode"),
  overrides: settingValue("sidebarProjectGroupingOverrides"),
}, null)));

export function expandProjectScope(ids: readonly string[], groups: ReadonlyArray<{ members: ReadonlyArray<{ id: string }> }>): string[] {
  if (ids.length === 0) return [];
  const selected = new Set(ids);
  for (const group of groups) {
    if (group.members.some((member) => selected.has(member.id))) {
      for (const member of group.members) selected.add(member.id);
    }
  }
  return [...selected];
}

export function setProjectScope(ids: string[]) {
  write(ids);
}

/** The thread menu's "Filter by <project>" / "Show all projects": scopes to one project, or clears it. */
export function toggleProjectScope(id: string) {
  const current = projectScopeIds();
  write(current.includes(id) ? [] : [id]);
}

/** Shift-click on a project in the picker adds or removes it from the scope. */
export function toggleProjectScopeMember(id: string) {
  const current = projectScopeIds();
  write(current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
}

export const inProjectScope = (ids: readonly string[], projectId: string) => ids.length === 0 || ids.includes(projectId);

export interface ProjectScopeItem { value: string; label: string }

/** projectScopeItems: "All projects", then every project the picker lists. */
export function projectScopeItemsOf(projects: ReadonlyArray<{ id: string; name: string }>): ProjectScopeItem[] {
  return [{ value: "all", label: "All projects" }, ...projects.map((project) => ({ value: project.id, label: project.name }))];
}

/** filterSidebarProjectScopeItems: a query keeps the projects whose name contains it (any case) and drops "All projects". */
export function filterProjectScopeItems(items: readonly ProjectScopeItem[], query: string): ProjectScopeItem[] {
  const text = query.trim().toLowerCase();
  if (text.length === 0) return [...items];
  return items.filter((item) => item.value !== "all" && item.label.toLowerCase().includes(text));
}

/** The items in the order they had when the menu opened (useOrderWhileOpen): pinning a row does not move it under the pointer. */
export function holdItemOrder<T extends { value: string }>(items: readonly T[], order: readonly string[] | null): T[] {
  if (order === null) return [...items];
  const rank = new Map(order.map((value, index) => [value, index] as const));
  return [...items].sort((a, b) => (rank.get(a.value) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.value) ?? Number.MAX_SAFE_INTEGER));
}
