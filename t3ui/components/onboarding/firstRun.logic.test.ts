import { expect, test } from "nsh/test";
import {
  isFirstRunWorkspaceProvenanceAuthoritative,
  isFreshFirstRunWorkspace,
  resolveFirstRunDecision,
  transitionFirstRunGateState,
  type FirstRunDecisionInput,
} from "./firstRun.logic";

const evidence: FirstRunDecisionInput = {
  enabled: true, hydrated: true, completed: false, bootstrapped: true, authoritative: true, workspaceAuthoritative: true,
  workspaceProvenanceAuthoritative: true, catalogReady: true, serverConfigAvailable: true, workspaceFresh: true, projectCount: 0, threadCount: 0,
};

// The server's own bootstrap of its cwd, as ServerLifecycleWelcomePayload reports it.
const welcome = { bootstrapProjectId: "project-1", bootstrapThreadId: "thread-1", bootstrapProjectCreated: true, bootstrapThreadCreated: true };
const bootstrapProject = { id: "project-1", environmentId: "env-1", workspaceRoot: "/Users/me/work" };
const bootstrapThread = { id: "thread-1", projectId: "project-1", environmentId: "env-1", latestRun: null, latestUserMessageAt: null, runtime: null };

test("a disabled gate or a completed onboarding opens the app and persists nothing", () => {
  expect(resolveFirstRunDecision({ ...evidence, enabled: false })).toEqual({ decision: "app", persistCompletion: false });
  expect(resolveFirstRunDecision({ ...evidence, completed: true })).toEqual({ decision: "app", persistCompletion: false });
});

test("nothing is decided before the saved settings are read", () => {
  expect(resolveFirstRunDecision({ ...evidence, hydrated: false })).toEqual({ decision: "pending", persistCompletion: false });
});

test("a fresh workspace on a live, fully reported server opens the wizard", () => {
  expect(resolveFirstRunDecision(evidence)).toEqual({ decision: "wizard", persistCompletion: false });
});

test("each missing piece of evidence keeps the decision pending", () => {
  for (const missing of ["bootstrapped", "authoritative", "workspaceProvenanceAuthoritative", "catalogReady", "serverConfigAvailable"] as const) {
    expect(resolveFirstRunDecision({ ...evidence, [missing]: false }).decision).toBe("pending");
  }
});

test("a workspace with its own work opens the app, and completion is saved once the evidence is authoritative", () => {
  expect(resolveFirstRunDecision({ ...evidence, workspaceFresh: false })).toEqual({ decision: "app", persistCompletion: true });
  expect(resolveFirstRunDecision({ ...evidence, workspaceFresh: false, workspaceAuthoritative: false })).toEqual({ decision: "app", persistCompletion: false });
  expect(resolveFirstRunDecision({ ...evidence, projectCount: 2, workspaceFresh: false })).toEqual({ decision: "app", persistCompletion: true });
  expect(resolveFirstRunDecision({ ...evidence, threadCount: 2, bootstrapped: false })).toEqual({ decision: "app", persistCompletion: false });
});

test("welcome provenance is authoritative once received and no longer pending", () => {
  expect(isFirstRunWorkspaceProvenanceAuthoritative({ welcomeReceived: false, bootstrapStatus: null })).toBe(false);
  expect(isFirstRunWorkspaceProvenanceAuthoritative({ welcomeReceived: true, bootstrapStatus: "pending" })).toBe(false);
  expect(isFirstRunWorkspaceProvenanceAuthoritative({ welcomeReceived: true, bootstrapStatus: "complete" })).toBe(true);
  expect(isFirstRunWorkspaceProvenanceAuthoritative({ welcomeReceived: true, bootstrapStatus: null })).toBe(true);
});

test("the gate state never flips once decided, and a timeout only marks a pending one as stalled", () => {
  const pending = { decision: "pending", stalled: false } as const;
  expect(transitionFirstRunGateState(pending, { type: "evidence", decision: "pending" })).toBe(pending);
  expect(transitionFirstRunGateState(pending, { type: "timeout" })).toEqual({ decision: "pending", stalled: true });
  const wizard = transitionFirstRunGateState({ decision: "pending", stalled: true }, { type: "evidence", decision: "wizard" });
  expect(wizard).toEqual({ decision: "wizard", stalled: false });
  expect(transitionFirstRunGateState(wizard, { type: "timeout" })).toBe(wizard);
  expect(transitionFirstRunGateState(wizard, { type: "evidence", decision: "wizard" })).toBe(wizard);
});

test("an empty server, or only its own cwd project, is a fresh workspace", () => {
  const base = { primaryEnvironmentId: "env-1", serverCwd: "/Users/me/work", ...welcome };
  expect(isFreshFirstRunWorkspace({ ...base, projects: [], threads: [] })).toBe(true);
  expect(isFreshFirstRunWorkspace({ ...base, projects: [bootstrapProject], threads: [] })).toBe(true);
  expect(isFreshFirstRunWorkspace({ ...base, projects: [bootstrapProject], threads: [bootstrapThread] })).toBe(true);
});

test("a project that is not the server's bootstrap, or a thread that ran, is not fresh", () => {
  const base = { primaryEnvironmentId: "env-1", serverCwd: "/Users/me/work", ...welcome };
  expect(isFreshFirstRunWorkspace({ ...base, projects: [{ ...bootstrapProject, workspaceRoot: "/Users/me/other" }], threads: [] })).toBe(false);
  expect(isFreshFirstRunWorkspace({ ...base, projects: [{ ...bootstrapProject, id: "project-2" }], threads: [] })).toBe(false);
  expect(isFreshFirstRunWorkspace({ ...base, bootstrapProjectCreated: false, projects: [bootstrapProject], threads: [] })).toBe(false);
  expect(isFreshFirstRunWorkspace({ ...base, projects: [bootstrapProject], threads: [{ ...bootstrapThread, latestUserMessageAt: "2026-01-01T00:00:00.000Z" }] })).toBe(false);
  expect(isFreshFirstRunWorkspace({ ...base, projects: [bootstrapProject], threads: [{ ...bootstrapThread, runtime: "idle" }] })).toBe(false);
  expect(isFreshFirstRunWorkspace({ ...base, projects: [bootstrapProject, { ...bootstrapProject, id: "p2" }], threads: [] })).toBe(false);
});
