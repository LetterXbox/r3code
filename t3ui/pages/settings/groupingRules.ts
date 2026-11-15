// CheckoutGroupingSelect (ProjectSettingsPanel.tsx) and withProjectGroupingOverride (sidebarProjectGrouping.ts): the
// grouping rule of each checkout, a client setting `sidebarProjectGroupingOverrides` that maps a checkout's key to a
// mode. Kept as JSON text here (a client setting holds one scalar).
export type GroupingMode = "repository" | "repository_path" | "separate";
export const PROJECT_GROUPING_MODE_LABELS: Record<GroupingMode, string> = {
  repository: "Group by repository",
  repository_path: "Group by repository path",
  separate: "Keep separate",
};
const MODES = Object.keys(PROJECT_GROUPING_MODE_LABELS) as GroupingMode[];

export function parseGroupingOverrides(value: unknown): Record<string, GroupingMode> {
  let raw: unknown = value;
  if (typeof value === "string") { try { raw = JSON.parse(value); } catch { return {}; } }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, GroupingMode] => MODES.includes(entry[1] as GroupingMode)));
}

export function withGroupingOverride(overrides: Readonly<Record<string, GroupingMode>>, key: string, selection: GroupingMode | "inherit"): Record<string, GroupingMode> {
  const next = { ...overrides };
  if (selection === "inherit") delete next[key];
  else next[key] = selection;
  return next;
}

/** The select's closed text: `Default (Group by repository)` while the checkout follows the global mode. */
export function groupingLabel(selection: GroupingMode | "inherit", globalMode: string): string {
  if (selection !== "inherit") return PROJECT_GROUPING_MODE_LABELS[selection];
  return `Default (${PROJECT_GROUPING_MODE_LABELS[(MODES.includes(globalMode as GroupingMode) ? globalMode : "repository") as GroupingMode]})`;
}

/** derivePhysicalProjectKey: a checkout is its environment and folder. */
export const checkoutKey = (environmentId: string, workspaceRoot: string) => `${environmentId}:${workspaceRoot}`;
