// The sidebar's project folders grouped by repository (sidebarProjectGrouping.ts and client-runtime projectGrouping.ts): checkouts of
// one repository share a folder unless their grouping rule keeps them apart. The rule of a checkout is
// `sidebarProjectGroupingOverrides[<environment>:<folder>]`, else the global `sidebarProjectGroupingMode`:
//   repository       one folder per repository
//   repository_path  one folder per repository and sub-folder of it
//   separate         one folder per checkout
import type { Project } from "../../store";

export type GroupingMode = "repository" | "repository_path" | "separate";
type Dict = Record<string, unknown>;
const dict = (value: unknown): Dict | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dict) : null);
const isMode = (value: unknown): value is GroupingMode => value === "repository" || value === "repository_path" || value === "separate";

/** derivePhysicalProjectKey: a checkout is its environment and folder (trailing slashes dropped). */
export const physicalProjectKey = (environmentId: string, workspaceRoot: string) => `${environmentId}:${workspaceRoot.trim().replace(/[\\/]+$/, "")}`;

export function parseOverrides(value: unknown): Record<string, GroupingMode> {
  let raw: unknown = value;
  if (typeof value === "string") { try { raw = JSON.parse(value); } catch { return {}; } }
  const record = dict(raw);
  return record ? Object.fromEntries(Object.entries(record).filter((entry): entry is [string, GroupingMode] => isMode(entry[1]))) : {};
}

const repositoryKey = (identity: Dict | null): string | null => {
  const origin = dict(identity?.origin);
  const key = typeof origin?.canonicalKey === "string" ? origin.canonicalKey : typeof identity?.canonicalKey === "string" ? identity.canonicalKey : null;
  return key && !key.includes("\0") ? key : null;
};

function relativePath(workspaceRoot: string, identity: Dict | null): string | null {
  const root = typeof identity?.rootPath === "string" ? identity.rootPath.trim().replace(/[\\/]+$/, "") : "";
  const folder = workspaceRoot.trim().replace(/[\\/]+$/, "");
  if (!root || !folder) return null;
  if (folder === root) return "";
  return folder.startsWith(`${root}/`) ? folder.slice(root.length + 1) : null;
}

/** The logical key a checkout groups under. */
export function logicalKey(project: Pick<Project, "path" | "repositoryIdentity">, environmentId: string, mode: GroupingMode): string {
  const physical = physicalProjectKey(environmentId, project.path ?? "");
  if (mode === "separate") return physical;
  const identity = dict(project.repositoryIdentity);
  const key = repositoryKey(identity);
  if (!key) return physical;
  if (mode === "repository") return key;
  const relative = relativePath(project.path ?? "", identity);
  return relative === null || relative === "" ? key : `${key}::${relative}`;
}

function groupName(members: readonly Project[]): string {
  const names = [...new Set(members.map((member) => member.name.trim()).filter(Boolean))];
  if (names.length === 1) return names[0]!;
  const display = [...new Set(members.map((member) => { const identity = dict(members.find((m) => m === member)?.repositoryIdentity); const origin = dict(identity?.origin); return typeof origin?.displayName === "string" ? origin.displayName : typeof identity?.displayName === "string" ? identity.displayName : null; }).filter((name): name is string => name !== null))];
  return display.length === 1 ? display[0]! : members[0]!.name;
}

/** groupSidebarProjects: merge the checkouts that share a logical key into one folder (the first member stands for it). */
export function groupSidebarProjects(projects: readonly Project[], input: { environmentId: string; globalMode: unknown; overrides: unknown }): Project[] {
  const mode = isMode(input.globalMode) ? input.globalMode : "repository";
  const overrides = parseOverrides(input.overrides);
  const groups = new Map<string, Project[]>();
  for (const project of projects) {
    // A checkout's physical key is its own environment's (a saved environment's project carries environmentId).
    const environmentId = project.environmentId ?? input.environmentId;
    const own = overrides[physicalProjectKey(environmentId, project.path ?? "")];
    const key = logicalKey(project, environmentId, own ?? mode);
    groups.set(key, [...(groups.get(key) ?? []), project]);
  }
  return [...groups.values()].map((members) => {
    if (members.length === 1) return members[0]!;
    const rep = members[0]!;
    return {
      ...rep,
      name: groupName(members),
      threads: members.flatMap((member) => member.threads),
      pinned: members.some((member) => member.pinned),
      createdAt: Math.min(...members.map((member) => member.createdAt ?? Infinity)),
      updatedAt: Math.max(...members.map((member) => member.updatedAt ?? 0)),
    };
  });
}

export type EnvironmentPresence = "local-only" | "remote-only" | "mixed";

/** buildSidebarProjectSnapshots: whether a group's checkouts are on this machine, saved environments or both. */
export function environmentPresence(members: readonly Pick<Project, "environmentId">[]): EnvironmentPresence {
  const local = members.some((member) => !member.environmentId);
  const remote = members.some((member) => Boolean(member.environmentId));
  return local && remote ? "mixed" : remote ? "remote-only" : "local-only";
}

/** projectGroupsSpanEnvironments: the badge column shows only when the groups cover more than one environment. */
export function projectGroupsSpanEnvironments(projects: readonly Pick<Project, "environmentId">[]): boolean {
  return new Set(projects.map((project) => project.environmentId ?? "")).size > 1;
}

/** ProjectEnvironmentBadge: "On <labels>" for a remote-only group, "Also on <labels>" when it is also local; null when local only. */
export function projectGroupEnvironmentDescription(members: readonly Pick<Project, "environmentId">[], labelOf: (environmentId: string) => string | null): string | null {
  const remote = members.filter((member) => Boolean(member.environmentId)).map((member) => labelOf(member.environmentId!) ?? "Remote").sort((a, b) => a.localeCompare(b));
  if (remote.length === 0) return null;
  const labels = remote.filter((label, index, all) => all.indexOf(label) === index).join(", ");
  return `${remote.length < members.length ? "Also on" : "On"} ${labels}`;
}

export interface ProjectPickerEntry { key: string; name: string; target: Project; members: Project[]; isPreferred: boolean }

/** buildSidebarProjectPickerEntries: one entry per logical project, opening the preferred project's checkout (or one on
 * its environment) else the group's own; the current project leads, even ahead of pinned ones. */
export function projectPickerEntries(projects: readonly Project[], input: { environmentId: string; globalMode: unknown; overrides: unknown }, preferredProjectId: string | null): ProjectPickerEntry[] {
  const mode = isMode(input.globalMode) ? input.globalMode : "repository";
  const overrides = parseOverrides(input.overrides);
  const groups = new Map<string, Project[]>();
  for (const project of projects) {
    const environmentId = project.environmentId ?? input.environmentId;
    const key = logicalKey(project, environmentId, overrides[physicalProjectKey(environmentId, project.path ?? "")] ?? mode);
    groups.set(key, [...(groups.get(key) ?? []), project]);
  }
  const preferred = preferredProjectId ? projects.find((project) => project.id === preferredProjectId) ?? null : null;
  const entries = [...groups.entries()].map(([key, members]): ProjectPickerEntry => {
    const isPreferred = preferred !== null && members.includes(preferred);
    const onPreferredEnvironment = preferred ? members.find((member) => (member.environmentId ?? "") === (preferred.environmentId ?? "")) : undefined;
    return { key, name: members.length === 1 ? members[0]!.name : groupName(members), target: isPreferred ? preferred! : onPreferredEnvironment ?? members[0]!, members, isPreferred };
  });
  const lead = entries.find((entry) => entry.isPreferred);
  return lead ? [lead, ...entries.filter((entry) => entry !== lead)] : entries;
}
