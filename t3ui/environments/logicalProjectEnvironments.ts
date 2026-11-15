// useLogicalProjectEnvironments.ts + useDraftEnvironmentRouting.ts onEnvironmentChange / ChatView composer.cycleHost:
// the machines a draft can run on are the connected environments holding a checkout of the same logical project
// (grouped by repository identity, projectGroupUpdate.ts), primary first then by label. Picking one moves the
// unsent draft to that checkout (environmentSelection "manual"). A scratch draft (no project) can run on every machine
// offering a scratch root; picking one without a scratch project yet creates it there first (openScratchProject).
import { allProjects, isServerThread, openThread, setDraftProject } from "../store";
import type { Project } from "../store";
import type { EnvironmentOption } from "../components/thread/environmentOptions";
import { liveGroupingInput, projectGroupMembers } from "./projectGroupUpdate";
import { machineOfProject } from "./machines";
import { chooseManualEnvironment } from "./loadBalancing";
import { connectedMachines } from "./machines";
import { environmentConfigs } from "./connectionManager";
import { factsFromConfig, isScratchProjectPath, scratchWorkspaceRoot } from "../components/sidebar/serverFacts";
import { scratchProjectId, SCRATCH_NOT_LOADED_MESSAGE } from "../components/thread/scratchProject";
import { showToast } from "../components/toast/toastState";

/** The scratch workspace root a machine offers ("primary" or a saved environment id). */
export function scratchRootOf(key: string): string | null {
  return key === PRIMARY_ENVIRONMENT_KEY ? scratchWorkspaceRoot() : factsFromConfig(environmentConfigs()[key]).scratchRoot;
}

/** useLogicalProjectEnvironments scratchDraft: every machine offering a scratch root, with its scratch project if listed. */
export function scratchProjectEnvironments(project: Project, all: readonly Project[] = allProjects(), machines = connectedMachines(), rootOf = scratchRootOf): EnvironmentOption[] {
  const active = environmentKeyOf(project);
  const options = machines.flatMap((machine): EnvironmentOption[] => {
    const root = rootOf(machine.key);
    if (root === null && machine.key !== active) return [];
    const scratch = machine.key === active ? project : all.find((item) => environmentKeyOf(item) === machine.key && isScratchProjectPath(item.path, root));
    return [{ environmentId: machine.key, projectId: scratch?.id ?? null, label: machine.label, isPrimary: machine.key === PRIMARY_ENVIRONMENT_KEY, machine: machine.machine, url: null }];
  });
  return options.sort((a, b) => a.isPrimary !== b.isPrimary ? (a.isPrimary ? -1 : 1) : a.label.localeCompare(b.label));
}

/** Whether a project is its machine's scratch project. */
export const isScratchDraftProject = (project: Project | null | undefined) => Boolean(project) && isScratchProjectPath(project!.path, scratchRootOf(environmentKeyOf(project!)));

export const PRIMARY_ENVIRONMENT_KEY = "primary";
const environmentKeyOf = (project: { environmentId?: string }) => project.environmentId ?? PRIMARY_ENVIRONMENT_KEY;

export function logicalProjectEnvironments(project: Project | null | undefined, all: readonly Project[] = allProjects(), machineOf = machineOfProject, grouping = liveGroupingInput(), scratch = isScratchDraftProject(project)): EnvironmentOption[] {
  if (!project) return [];
  if (scratch) return scratchProjectEnvironments(project, all);
  const seen = new Set<string>();
  const options: EnvironmentOption[] = [];
  const members = projectGroupMembers(project, all, grouping);
  // allProjects order, like the reference's loop over allProjects (first checkout per environment wins).
  for (const candidate of all.filter((item) => members.includes(item))) {
    const key = environmentKeyOf(candidate);
    if (seen.has(key)) continue;
    const machine = machineOf(candidate);
    if (!machine && candidate.id !== project.id) continue;
    seen.add(key);
    options.push({ environmentId: key, projectId: candidate.id, label: machine?.label ?? key, isPrimary: key === PRIMARY_ENVIRONMENT_KEY, machine: machine?.machine ?? "server", url: null });
  }
  return options.sort((a, b) => a.isPrimary !== b.isPrimary ? (a.isPrimary ? -1 : 1) : a.label.localeCompare(b.label));
}

export const draftEnvironmentKey = (project: { environmentId?: string } | null | undefined) => project ? environmentKeyOf(project) : null;

/** onEnvironmentChange: moves the open unsent draft to the target environment's checkout. */
export function changeDraftEnvironment(options: readonly EnvironmentOption[], environmentId: string): boolean {
  const thread = openThread();
  if (!thread || isServerThread(thread.id)) return false;
  const target = options.find((option) => option.environmentId === environmentId);
  if (!target) return false;
  chooseManualEnvironment();
  if (target.projectId) { if (target.projectId !== thread.projectId) setDraftProject(target.projectId); return true; }
  // No scratch project on that machine yet: create it there, then move the draft if it is still the same unsent draft.
  const machine = connectedMachines().find((item) => item.key === environmentId);
  if (!machine) return false;
  const draftId = thread.id;
  const origin = thread.projectId;
  void (async () => {
    try {
      const localId = scratchProjectId(await machine.request("projects.ensureScratch", {}));
      if (!localId) throw new Error("The server did not return a scratch project.");
      const projectId = machine.scope(localId);
      for (let attempt = 0; attempt < 40 && !allProjects().some((project) => project.id === projectId); attempt++) await new Promise((resolve) => setTimeout(resolve, 250));
      if (!allProjects().some((project) => project.id === projectId)) throw new Error(SCRATCH_NOT_LOADED_MESSAGE);
      const current = openThread();
      if (current?.id === draftId && current.projectId === origin && !isServerThread(draftId)) setDraftProject(projectId);
    } catch (error) {
      showToast({ type: "error", title: "Could not switch machine", description: error instanceof Error ? error.message : String(error) });
    }
  })();
  return true;
}

/** composer.cycleHost: the next environment of the draft's logical project, wrapping around. */
export function cycleDraftEnvironment(): boolean {
  const thread = openThread();
  if (!thread || isServerThread(thread.id) || !thread.projectId) return false;
  const project = allProjects().find((item) => item.id === thread.projectId);
  const options = logicalProjectEnvironments(project);
  if (options.length < 2) return false;
  const index = options.findIndex((option) => option.environmentId === draftEnvironmentKey(project));
  const next = options[(index + 1) % options.length];
  return next ? changeDraftEnvironment(options, next.environmentId) : false;
}
