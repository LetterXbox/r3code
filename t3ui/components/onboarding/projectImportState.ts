// The Welcome page's project import (WelcomePage.tsx's useProjectScans and useProjectImport) over the real RPCs: `agentSessions.scan`
// lists the projects found in Claude Code, Codex and Pi history; each picked project is created (`projects.mutate` project.create, unless
// the server already matches it) and its threads imported with `agentSessions.import`.
import { signal } from "nsh";
import { allProjects, requestBackend } from "../../store";
import {
  importWarning,
  isNewOnboardingProject,
  partitionOnboardingProjects,
  readAgentSessionScan,
  resolveOnboardingProjectId,
  type AgentSessionScan,
  type ImportCandidate,
} from "./projectImport.logic";

type Request = (method: string, payload: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
// The scan reads every agent's history and the import writes a project's whole history: both take as long as the
// server needs (the web's RPC commands have no client timeout), so they are never cut off at the default 30 s.
const UNBOUNDED = { timeoutMs: Infinity };

const scan = signal<AgentSessionScan | null>(null);
const scanPending = signal(false);
const scanError = signal<string | null>(null);
/** The user's own picks; until one is made the default (recent new projects) stands. */
const picks = signal<{ keys: string[]; optedOut: boolean } | null>(null);
const importing = signal(false);
const importError = signal<string | null>(null);

export const projectScan = () => scan();
export const projectScanPending = () => scanPending();
export const projectScanError = () => scanError();
export const projectImporting = () => importing();
export const projectImportError = () => importError();

const errorText = (error: unknown) => (error instanceof Error && error.message ? error.message : "Request failed");

export async function refreshProjectScan(request: Request = requestBackend): Promise<void> {
  scanPending.set(true);
  try {
    const result = readAgentSessionScan(await request("agentSessions.scan", {}, UNBOUNDED));
    if (!result) throw new Error("The server sent an unreadable project scan.");
    scan.set(result);
    scanError.set(null);
  } catch (error) {
    scanError.set(errorText(error));
  } finally {
    scanPending.set(false);
  }
}

const liveProjects = () => allProjects().map((project) => ({ id: project.id, workspaceRoot: project.path ?? "" }));

export const candidateKey = (candidate: Pick<ImportCandidate, "path">) => candidate.path;

export function scanCandidates(): ImportCandidate[] { return scan()?.candidates ?? []; }

/** The projects the page would import: the default recent new ones until the user picks, then their picks. */
export function selectedCandidates(): ImportCandidate[] {
  const candidates = scanCandidates();
  const choice = picks();
  if (choice?.optedOut) return [];
  if (choice) return candidates.filter((candidate) => choice.keys.includes(candidateKey(candidate)));
  const isNew = isNewOnboardingProject(liveProjects());
  return partitionOnboardingProjects(candidates).recent.filter(isNew);
}

export function defaultCandidates(): ImportCandidate[] {
  const candidates = scanCandidates();
  const isNew = isNewOnboardingProject(liveProjects());
  const recent = partitionOnboardingProjects(candidates).recent.filter(isNew);
  const fresh = candidates.filter(isNew);
  return recent.length > 0 ? recent : fresh.length > 0 ? fresh : candidates;
}

export function setSelectedKeys(keys: readonly string[], optedOut = false) { picks.set({ keys: [...keys], optedOut }); }
export function isNewCandidate(candidate: ImportCandidate): boolean { return isNewOnboardingProject(liveProjects())(candidate); }

export function resetProjectImportForTest() {
  scan.set(null); scanPending.set(false); scanError.set(null); picks.set(null); importing.set(false); importError.set(null);
}

export interface ImportOutcome { importedThreads: number; warning: string; landingProjectId: string | null }

/** Creates what is missing and imports each picked project's history; a project that fails is skipped and reported in the warning. */
export async function runProjectImport(selection: readonly ImportCandidate[], request: Request = requestBackend): Promise<ImportOutcome> {
  importing.set(true);
  importError.set(null);
  let importedThreads = 0;
  let skippedThreads = 0;
  let failed = 0;
  let landing: string | null = null;
  let landingWithHistory: string | null = null;
  try {
    for (const candidate of selection) {
      try {
        let projectId = resolveOnboardingProjectId(liveProjects(), candidate);
        if (projectId === null) {
          projectId = `project:${crypto.randomUUID()}`;
          await request("projects.mutate", {
            type: "project.create", commandId: `onboarding:project:create:${projectId}`, projectId, title: candidate.title,
            workspaceRoot: candidate.path, createWorkspaceRootIfMissing: false, defaultModelSelection: null,
          });
        }
        const result = await request("agentSessions.import", { projectId, expectedWorkspaceRoot: candidate.path }, UNBOUNDED) as { importedCount?: number; skippedCount?: number } | null;
        const imported = typeof result?.importedCount === "number" ? result.importedCount : 0;
        importedThreads += imported;
        skippedThreads += typeof result?.skippedCount === "number" ? result.skippedCount : 0;
        landing ??= projectId;
        if (imported > 0) landingWithHistory ??= projectId;
      } catch (error) {
        failed += 1;
        importError.set(errorText(error));
      }
    }
  } finally {
    importing.set(false);
  }
  const incomplete = skippedThreads > 0 || failed > 0;
  return { importedThreads, warning: incomplete ? importWarning({ importedThreads, skippedThreads }) : "", landingProjectId: landingWithHistory ?? landing };
}
