// onboarding/firstRun.logic.ts: when the app opens on the Welcome page instead of the shell. The decision waits for
// evidence (settings read, shell snapshot, welcome, config) and never flips once made, except to give up after a timeout.
import { normalizeProjectPathForComparison } from "../palette/addProject/addProjectLogic";

export type FirstRunDecision = "pending" | "app" | "wizard";

export interface FirstRunGateState { readonly decision: FirstRunDecision; readonly stalled: boolean }

export type FirstRunGateEvent = { readonly type: "evidence"; readonly decision: FirstRunDecision } | { readonly type: "timeout" };

export interface FirstRunWorkspaceInput {
  readonly primaryEnvironmentId: string | null;
  readonly serverCwd: string | null;
  readonly bootstrapProjectId?: string | null | undefined;
  readonly bootstrapThreadId?: string | null | undefined;
  readonly bootstrapProjectCreated?: boolean | null | undefined;
  readonly bootstrapThreadCreated?: boolean | null | undefined;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly environmentId: string | null; readonly workspaceRoot: string }>;
  readonly threads: ReadonlyArray<{
    readonly id: string;
    readonly projectId: string;
    readonly environmentId: string | null;
    readonly latestRun: unknown;
    readonly latestUserMessageAt: string | number | null;
    readonly runtime: unknown;
  }>;
}

export interface FirstRunDecisionInput {
  readonly enabled: boolean;
  readonly hydrated: boolean;
  readonly completed: boolean;
  readonly bootstrapped: boolean;
  readonly authoritative: boolean;
  readonly workspaceAuthoritative: boolean;
  readonly workspaceProvenanceAuthoritative: boolean;
  readonly catalogReady: boolean;
  readonly serverConfigAvailable: boolean;
  readonly workspaceFresh: boolean;
  readonly projectCount: number;
  readonly threadCount: number;
}

export const FIRST_RUN_DECISION_TIMEOUT_MS = 4_000;

export function isFirstRunWorkspaceProvenanceAuthoritative(input: { readonly welcomeReceived: boolean; readonly bootstrapStatus: "pending" | "complete" | null }): boolean {
  return input.welcomeReceived && input.bootstrapStatus !== "pending";
}

export function transitionFirstRunGateState(state: FirstRunGateState, event: FirstRunGateEvent): FirstRunGateState {
  if (event.type === "timeout") return state.decision === "pending" && !state.stalled ? { ...state, stalled: true } : state;
  if (event.decision === "pending" || state.decision === event.decision) return state;
  return { decision: event.decision, stalled: false };
}

/** The server's own bootstrap project and thread (its cwd) count as a fresh workspace, so `npx t3` users still see onboarding. */
export function isFreshFirstRunWorkspace(input: FirstRunWorkspaceInput): boolean {
  if (input.projects.length > 1 || input.threads.length > 1) return false;
  const bootstrapProject = input.projects[0];
  if (bootstrapProject !== undefined) {
    if (
      input.bootstrapProjectCreated !== true ||
      input.bootstrapProjectId !== bootstrapProject.id ||
      input.serverCwd === null ||
      bootstrapProject.environmentId !== input.primaryEnvironmentId ||
      normalizeProjectPathForComparison(bootstrapProject.workspaceRoot) !== normalizeProjectPathForComparison(input.serverCwd)
    ) return false;
  }
  const bootstrapThread = input.threads[0];
  if (bootstrapThread === undefined) return true;
  return (
    bootstrapProject !== undefined &&
    input.bootstrapThreadCreated === true &&
    input.bootstrapThreadId === bootstrapThread.id &&
    bootstrapThread.environmentId === input.primaryEnvironmentId &&
    bootstrapThread.projectId === bootstrapProject.id &&
    bootstrapThread.latestRun === null &&
    bootstrapThread.latestUserMessageAt === null &&
    bootstrapThread.runtime === null
  );
}

export function resolveFirstRunDecision(input: FirstRunDecisionInput): { readonly decision: FirstRunDecision; readonly persistCompletion: boolean } {
  if (!input.enabled || (input.hydrated && input.completed)) return { decision: "app", persistCompletion: false };
  if (!input.hydrated) return { decision: "pending", persistCompletion: false };
  if (input.projectCount > 1 || input.threadCount > 1) {
    return {
      decision: "app",
      persistCompletion: input.bootstrapped && input.authoritative && input.workspaceAuthoritative && input.catalogReady && input.serverConfigAvailable,
    };
  }
  if (!input.bootstrapped || !input.authoritative || !input.workspaceProvenanceAuthoritative || !input.catalogReady || !input.serverConfigAvailable) {
    return { decision: "pending", persistCompletion: false };
  }
  return input.workspaceFresh ? { decision: "wizard", persistCompletion: false } : { decision: "app", persistCompletion: input.workspaceAuthoritative };
}
