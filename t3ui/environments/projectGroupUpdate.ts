// useProjectGroupUpdate.ts: one title / icon / pin / archive change written to every machine's checkout of a project
// (the checkouts that share its logical key), one machine at a time; the first failure is a toast ("<title> on
// <machine>" when there are several) and stops the rest. Every machine must be connected first.
import { backendStatus, requestBackend, settingValue } from "../store";
import type { Project } from "../store";
import { logicalKey, parseOverrides, physicalProjectKey, type GroupingMode } from "../components/sidebar/projectGrouping";
import { environmentConnections, managedEnvironment } from "./connectionManager";
import { serverEnvironment } from "../pages/settings/settingsState";
import { projectUpdate } from "../pages/settings/projectsLogic";
import { showToast } from "../components/toast";

const MODES: readonly GroupingMode[] = ["repository", "repository_path", "separate"];

/** The checkouts grouped with `project` (itself first), as the sidebar groups them. */
export function projectGroupMembers(project: Project, all: readonly Project[], input: { primaryEnvironmentId: string; globalMode: unknown; overrides: unknown }): Project[] {
  const mode = MODES.includes(input.globalMode as GroupingMode) ? (input.globalMode as GroupingMode) : "repository";
  const overrides = parseOverrides(input.overrides);
  const keyOf = (candidate: Project) => {
    const environmentId = candidate.environmentId ?? input.primaryEnvironmentId;
    return logicalKey(candidate, environmentId, overrides[physicalProjectKey(environmentId, candidate.path ?? "")] ?? mode);
  };
  const key = keyOf(project);
  return [project, ...all.filter((candidate) => candidate.id !== project.id && keyOf(candidate) === key)];
}

export interface ProjectGroupDeps {
  /** The member's machine label, null for an unnamed one. */
  label: (member: Project) => string | null;
  connected: (member: Project) => boolean;
  request: (method: string, payload: unknown) => Promise<unknown>;
  toast: (title: string, description: string) => void;
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : "An error occurred.");

export async function updateProjectGroup(members: readonly Project[], fields: Record<string, unknown> | ((member: Project) => Record<string, unknown>), failureTitle: string, deps: ProjectGroupDeps = liveDeps()): Promise<boolean> {
  const unavailable = members.find((member) => !deps.connected(member));
  if (unavailable) {
    deps.toast(failureTitle, `Connect ${deps.label(unavailable) ?? "the selected environment"} and try again.`);
    return false;
  }
  for (const member of members) {
    try {
      await deps.request("projects.mutate", projectUpdate(member.id, typeof fields === "function" ? fields(member) : fields));
    } catch (cause) {
      deps.toast(members.length > 1 ? `${failureTitle} on ${deps.label(member) ?? "the current environment"}` : failureTitle, message(cause));
      return false;
    }
  }
  return true;
}

function liveDeps(): ProjectGroupDeps {
  return {
    label: (member) => (member.environmentId ? managedEnvironment(member.environmentId)?.label ?? null : (() => { const label = serverEnvironment()?.label; return typeof label === "string" && label ? label : null; })()),
    connected: (member) => (member.environmentId ? environmentConnections()[member.environmentId]?.phase === "connected" : backendStatus() === "connected"),
    // Scoped ids of a saved environment's projects are routed to that environment's session (routePayload).
    request: (method, payload) => requestBackend(method, payload),
    toast: (title, description) => showToast({ type: "error", title, description }),
  };
}

/** The live grouping input for projectGroupMembers. */
export function liveGroupingInput() {
  return { primaryEnvironmentId: String(serverEnvironment()?.environmentId ?? ""), globalMode: settingValue("sidebarProjectGroupingMode"), overrides: settingValue("sidebarProjectGroupingOverrides") };
}
