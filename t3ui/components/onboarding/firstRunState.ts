// The first-run gate's state (FirstRunGate.tsx's hooks and onboarding/firstRun.ts): what the gate has decided, whether the
// saved onboarding completion was read, and the Welcome page that Settings can reopen mid-session. The web keeps
// `onboardingCompletedAt` in its client settings; this app keeps it in its own storage key.
import { effect, signal, Storage, untracked } from "nsh";
import { allProjects, allThreads, backendBearer, backendStatus, backendUrl, providersLoaded, shellSnapshotLoaded } from "../../store";
import { serverWelcome } from "../coordinators/serverStreams";
import {
  FIRST_RUN_DECISION_TIMEOUT_MS,
  isFirstRunWorkspaceProvenanceAuthoritative,
  isFreshFirstRunWorkspace,
  resolveFirstRunDecision,
  transitionFirstRunGateState,
  type FirstRunGateState,
} from "./firstRun.logic";

export const ONBOARDING_STORAGE_KEY = "onboardingCompletedAt";

const hydration = signal<"pending" | "ready" | "failed">("pending");
const completedAt = signal<string | null>(null);
const gate = signal<FirstRunGateState>({ decision: "pending", stalled: false });
/** Set while Settings reopened the Welcome page (the web's /welcome route reached from About). */
const welcomeReopened = signal(false);
let hydrating: Promise<void> | null = null;

export const onboardingHydration = () => hydration();
export const onboardingCompletedAt = () => completedAt();
export const firstRunDecision = () => gate().decision;
export const firstRunStalled = () => gate().stalled;
export const welcomeReopenedFromSettings = () => welcomeReopened();

/** ensureClientSettingsHydrated for the one saved field the gate needs. */
export function ensureOnboardingHydrated(): Promise<void> {
  hydrating ??= Storage.getItem(ONBOARDING_STORAGE_KEY).then((value) => {
    completedAt.set(value);
    hydration.set("ready");
  }).catch(() => {
    hydrating = null;
    hydration.set("failed");
  });
  return hydrating;
}

/** completeOnboarding: stamps the moment the Welcome page (or the gate's own skip) finished. */
export async function completeOnboarding(): Promise<void> {
  const stamp = new Date().toISOString();
  await Storage.setItem(ONBOARDING_STORAGE_KEY, stamp);
  completedAt.set(stamp);
  hydration.set("ready");
}

export function openWelcomePage() { welcomeReopened.set(true); }
export function closeWelcomePage() { welcomeReopened.set(false); }

/**
 * Whether the gate applies: only an environment that is connected or connecting can say a workspace is fresh. A fixture store
 * with no environment or no session credential, or one that failed to connect, opens the app, whose own "Connect an environment" state is the way out.
 */
const forced = signal<boolean | null>(null);
/** Tests only: pretend a session credential does (true) or does not (false) exist; null restores the real check. */
export function forceFirstRunGateForTest(value: boolean | null) { forced.set(value); }
export const gateEnabled = () => (forced() ?? (backendUrl() !== "" && backendBearer() !== null)) && (backendStatus() === "connected" || backendStatus() === "connecting");

/** The decision the shell acts on: "app" whenever the gate does not apply. */
export const effectiveFirstRunDecision = () => (gateEnabled() ? gate().decision : "app");
export const effectiveFirstRunStalled = () => gateEnabled() && gate().stalled;

export function resetFirstRunForTest(options: { completed?: string | null; hydration?: "pending" | "ready" | "failed" } = {}) {
  completedAt.set(options.completed ?? null);
  hydration.set(options.hydration ?? "ready");
  gate.set({ decision: "pending", stalled: false });
  welcomeReopened.set(false);
  hydrating = Promise.resolve();
}

let installed = false;

/** Feeds the gate from the store; once, at startup. */
export function installFirstRunGate() {
  if (installed) return;
  installed = true;
  void ensureOnboardingHydrated();
  effect(() => {
    const hydrated = hydration() === "ready";
    const enabled = gateEnabled();
    const completed = completedAt() !== null;
    const connected = backendStatus() === "connected";
    const bootstrapped = shellSnapshotLoaded();
    // The config snapshot carries the provider list: providersLoaded is its arrival (primaryServerConfigAtom !== null in the web).
    const configAvailable = providersLoaded();
    const welcome = serverWelcome();
    const projects = allProjects();
    const threads = allThreads();
    const environmentId = welcome?.environmentId ?? null;
    const projectCount = projects.length;
    const threadCount = threads.length;
    const live = connected && bootstrapped;
    const workspaceFresh = threadCount <= 1 && isFreshFirstRunWorkspace({
      primaryEnvironmentId: environmentId,
      serverCwd: welcome?.cwd ?? null,
      bootstrapProjectId: welcome?.bootstrapProjectId,
      bootstrapThreadId: welcome?.bootstrapThreadId,
      bootstrapProjectCreated: welcome?.bootstrapProjectCreated,
      bootstrapThreadCreated: welcome?.bootstrapThreadCreated,
      projects: projects.map((project) => ({ id: project.id, environmentId, workspaceRoot: project.path ?? "" })),
      threads: threads.map((thread) => ({
        id: thread.id,
        projectId: thread.projectId,
        environmentId,
        latestRun: thread.meta?.latestRunId ?? null,
        latestUserMessageAt: thread.latestUserMessageAt ? thread.latestUserMessageAt : null,
        runtime: thread.meta?.runtimeStatus ?? null,
      })),
    });
    const { decision, persistCompletion } = resolveFirstRunDecision({
      enabled,
      hydrated,
      completed,
      bootstrapped: live,
      authoritative: live,
      workspaceAuthoritative: live,
      workspaceProvenanceAuthoritative: isFirstRunWorkspaceProvenanceAuthoritative({ welcomeReceived: welcome !== null, bootstrapStatus: welcome?.bootstrapStatus ?? null }),
      catalogReady: configAvailable,
      serverConfigAvailable: configAvailable,
      workspaceFresh,
      projectCount,
      threadCount,
    });
    untracked(() => {
      if (hydrated) {
        const next = transitionFirstRunGateState(gate(), { type: "evidence", decision });
        if (next !== gate()) gate.set(next);
      }
      if (decision !== "wizard" && hydrated && persistCompletion && !completed) void completeOnboarding().catch(() => undefined);
    });
  });
  effect(() => {
    const decision = gate().decision;
    const waiting = gateEnabled() && decision === "pending" && hydration() === "ready";
    if (!waiting) return;
    const timer = setTimeout(() => gate.update((state) => transitionFirstRunGateState(state, { type: "timeout" })), FIRST_RUN_DECISION_TIMEOUT_MS);
    return () => clearTimeout(timer);
  });
}
