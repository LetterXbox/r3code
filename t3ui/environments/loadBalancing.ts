// Load balancing for new drafts (hooks/useLoadBalancedEnvironment.ts + chat/useDraftEnvironmentRouting.ts): with
// "Automatically balance load" on, an unsent draft in a project checked out on several connected machines moves to the
// machine with the most free CPU and memory, weighted by each machine's preference (server.getHostResources, a 15 s
// freshness window, client-runtime load-balancing.ts chooseLoadBalancedEnvironment). One pick per draft, as the
// reference stores loadBalancedEnvironmentId once; Run on shows "Auto balance" / "Checking machines…" / "Auto balance
// unavailable" and offers Auto balance again after a manual pick. With a single connected environment there is nothing
// to choose and the draft stays where it is.
import { effect, signal, untracked } from "nsh";
import { showToast } from "../components/toast/toastState";
import { allProjects, draftAttachments, isServerThread, openThread, setDraftProject, workspaceStrategy } from "../store";
import type { Project } from "../store";
import { clientSettings, clientSettingsHydrated } from "../pages/settings/providers/clientSettings";
import { liveGroupingInput, projectGroupMembers } from "./projectGroupUpdate";
import { machineOfProject } from "./machines";
import { managedEnvironment } from "./connectionManager";
import { backendUrl, composerDraft } from "../store";
import { attachedExtraContexts, extraContextMarker } from "../components/composer/contextChips";
import { serverEnvironmentIdOf } from "./machineMentions";
import { serverEnvironment } from "../pages/settings/settingsState";

export interface HostResourcesSnapshot { cpuCount: number; cpuUtilization: number | null; totalMemoryBytes: number; availableMemoryBytes: number; sampledAt?: number }

/** client-runtime load-balancing.ts, 1:1. */
export function chooseLoadBalancedEnvironment(
  candidates: ReadonlyArray<{ environmentId: string; resources: HostResourcesSnapshot | null; receivedAt?: number; weight: number }>,
  now: number,
): string | null {
  let selected: string | null = null;
  let bestScore = 0;
  for (const { environmentId, resources, receivedAt, weight } of candidates) {
    const sampledAt = receivedAt ?? resources?.sampledAt ?? 0;
    if (
      !resources || !Number.isFinite(weight) || weight <= 0 || now - sampledAt > 15_000 || sampledAt > now + 5_000 ||
      resources.cpuUtilization === null || resources.cpuUtilization >= 0.95 || resources.totalMemoryBytes <= 0 || resources.cpuCount <= 0
    ) continue;
    const memoryAvailable = resources.availableMemoryBytes / resources.totalMemoryBytes;
    if (memoryAvailable <= 0.05) continue;
    const score = weight * resources.cpuCount * (1 - resources.cpuUtilization) * memoryAvailable;
    if (score > bestScore) { selected = environmentId; bestScore = score; }
  }
  return selected;
}

function parseResources(value: unknown): HostResourcesSnapshot | null {
  const item = value as Record<string, unknown> | null;
  if (!item || typeof item.cpuCount !== "number" || typeof item.totalMemoryBytes !== "number" || typeof item.availableMemoryBytes !== "number") return null;
  return { cpuCount: item.cpuCount, cpuUtilization: typeof item.cpuUtilization === "number" ? item.cpuUtilization : null, totalMemoryBytes: item.totalMemoryBytes, availableMemoryBytes: item.availableMemoryBytes };
}

/** The settings rows key weights by the environment's address (Connection.tsx balancingEnvironments). */
function weightKey(project: Project): string {
  return project.environmentId ? (managedEnvironment(project.environmentId)?.url ?? project.environmentId) : backendUrl();
}

export interface BalanceCandidate { member: Project; request: (method: string, payload: unknown) => Promise<unknown>; weight: number }

/** The checkouts of a project on connected machines with their weights (useDraftEnvironmentRouting's candidates). */
export function balanceCandidates(members: readonly Project[], weights: Readonly<Record<string, number>>): BalanceCandidate[] {
  return members.flatMap((member) => {
    const machine = machineOfProject(member);
    const weight = weights[weightKey(member)] ?? 50;
    return machine && weight > 0 ? [{ member, request: machine.request, weight }] : [];
  });
}

const HOST_RESOURCES_TIMEOUT_MS = 5000;

/** Reads each candidate's server.getHostResources and picks one, or null when none qualifies or a read failed for all. */
export async function pickLoadBalancedProject(candidates: readonly BalanceCandidate[], now: () => number = Date.now): Promise<{ chosen: Project | null; failed: boolean }> {
  if (candidates.length < 2) return { chosen: null, failed: false };
  let failures = 0;
  const sampled = await Promise.all(candidates.map(async (candidate) => {
    try {
      // state/server.ts hostResources: Effect.timeout("5 seconds").
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Request timed out.")), HOST_RESOURCES_TIMEOUT_MS); });
      const answer = await Promise.race([candidate.request("server.getHostResources", {}), deadline]).finally(() => clearTimeout(timer));
      const resources = parseResources(answer);
      return { environmentId: candidate.member.id, resources, receivedAt: now(), weight: candidate.weight };
    } catch { failures += 1; return { environmentId: candidate.member.id, resources: null, receivedAt: 0, weight: candidate.weight }; }
  }));
  const id = chooseLoadBalancedEnvironment(sampled, now());
  const chosen = candidates.find((candidate) => candidate.member.id === id)?.member ?? null;
  return { chosen, failed: chosen === null && failures > 0 };
}

// Per draft: environmentSelection "manual" (a machine picked by hand), loadBalancedEnvironmentId (picked once), and the
// pick in flight or failed (useLoadBalancedEnvironment's pending / failed).
const manual = signal<string[]>([]);
const balanced = signal<Record<string, string>>({});
const pending = signal<string[]>([]);
const failed = signal<string[]>([]);
const without = (list: string[], id: string) => list.filter((entry) => entry !== id);

function draftMembers(thread: { id: string; projectId?: string | null } | undefined): Project[] | null {
  if (!thread || isServerThread(thread.id) || !thread.projectId) return null;
  const project = allProjects().find((item) => item.id === thread.projectId);
  if (!project) return null;
  const members = projectGroupMembers(project, allProjects(), liveGroupingInput());
  return members.length >= 2 ? members : null;
}

/** ChatView's onAutoEnvironment condition: a draft whose project is on 2+ machines, with load balancing on. */
export function canAutoBalance(): boolean {
  return clientSettingsHydrated() && clientSettings().loadBalancingEnabled && draftMembers(openThread()) !== null;
}

/** ChatView's automaticEnvironment: no manual pick, no attachments unless already balanced, no branch or worktree. */
function automatic(threadId: string): boolean {
  const workspace = workspaceStrategy();
  return canAutoBalance() && !manual().includes(threadId) && (draftAttachments().length === 0 || threadId in balanced())
    && workspace.type === "root" && !(workspace as { branch?: string }).branch;
}

/** useDraftEnvironmentRouting autoEnvironmentLabel: undefined unless the open draft routes automatically. */
export function autoEnvironmentLabel(): string | undefined {
  const thread = openThread();
  if (!thread || !automatic(thread.id)) return undefined;
  if (thread.id in balanced()) return "Auto balance";
  if (pending().includes(thread.id)) return "Checking machines…";
  if (failed().includes(thread.id)) return "Auto balance unavailable";
  return "Auto balance";
}

/** A machine picked by hand in Run on: this draft stops balancing (environmentSelection "manual"). */
export function chooseManualEnvironment(): void {
  const thread = openThread();
  if (thread) manual.update((list) => [...without(list, thread.id), thread.id]);
}

/** onAutoEnvironment: back to automatic routing, picked afresh; attachments stay where they were uploaded. */
export function chooseAutoEnvironment(): void {
  const thread = openThread();
  if (!thread || isServerThread(thread.id)) return;
  if (draftAttachments().length > 0) {
    showToast({ type: "warning", id: "load-balancing-attachments", title: "Keep attachments on this machine", description: "Remove attachments before choosing automatic routing, then attach them on the selected machine." });
    return;
  }
  manual.update((list) => without(list, thread.id));
  failed.update((list) => without(list, thread.id));
  balanced.update(({ [thread.id]: _gone, ...rest }) => rest);
}

/** Root coordinator: balances each automatic draft once. */
export function installDraftLoadBalancing() {
  effect(() => {
    const thread = openThread();
    if (!thread || !automatic(thread.id) || thread.id in balanced() || pending().includes(thread.id) || failed().includes(thread.id)) return;
    const members = untracked(() => draftMembers(thread));
    if (!members) return;
    const id = thread.id;
    pending.update((list) => [...list, id]);
    void pickLoadBalancedProject(balanceCandidates(members, clientSettings().loadBalancingWeights)).then(({ chosen, failed: didFail }) => {
      pending.update((list) => without(list, id));
      if (didFail || !chosen) { failed.update((list) => [...without(list, id), id]); return; }
      balanced.update((all) => ({ ...all, [id]: chosen.id }));
      if (chosen.id === thread.projectId || openThread()?.id !== id || isServerThread(id)) return;
      try { setDraftProject(chosen.id); } catch { /* the draft started or the project went away */ }
    });
  });
}

/** composerSend.logic.ts loadBalancingSendWarning: why a send waits for a machine pick. */
export function loadBalancingSendWarning(input: { pending: boolean; threadContextEnvironmentIds: readonly (string | null)[]; candidateEnvironmentIds: readonly string[] }): { title: string; description: string } {
  if (input.pending) return { title: "Checking machine resources", description: "Resource checks are still running. You can choose a machine in the composer." };
  const noMachineReadsEveryThread = input.threadContextEnvironmentIds.length > 0
    && !input.candidateEnvironmentIds.some((environmentId) => input.threadContextEnvironmentIds.every((id) => id === environmentId));
  return {
    title: "Choose a machine to continue",
    description: noMachineReadsEveryThread
      ? "No machine can read every attached thread. Choose a machine in the composer or remove the threads."
      : "No eligible machine has available resources. Choose a machine in the composer to override.",
  };
}

/** useComposerSend needsLoadBalancing: the open automatic draft has no balanced machine yet; the warning to show, or null. */
export function pendingLoadBalancingSendWarning(): { title: string; description: string } | null {
  const thread = openThread();
  if (!thread || !automatic(thread.id) || thread.id in balanced()) return null;
  const members = draftMembers(thread) ?? [];
  const primaryConfig = { environment: serverEnvironment() };
  // referencedThreadContexts: the attached threads the prompt still links to, by their machine.
  const draft = composerDraft();
  const threadContextEnvironmentIds = attachedExtraContexts(thread.id).filter((record) => record.kind === "thread" && draft.includes(extraContextMarker(record))).map((record) => (record as { environmentId: string }).environmentId);
  const candidateEnvironmentIds = members.flatMap((member) => { const id = serverEnvironmentIdOf(member.environmentId ?? "primary", primaryConfig); return id ? [id] : []; });
  return loadBalancingSendWarning({ pending: pending().includes(thread.id), threadContextEnvironmentIds, candidateEnvironmentIds });
}

/** useSystemComposerBanners autoUpdateEnvironments: the machines an automatic draft may run on (none otherwise). */
export function automaticDraftMembers(): Project[] {
  const thread = openThread();
  return thread && automatic(thread.id) ? draftMembers(thread) ?? [] : [];
}
