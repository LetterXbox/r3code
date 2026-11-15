// onboarding/projectImport.logic.ts: the projects the server finds in the agents' own history (`agentSessions.scan`), which ones the
// Welcome page picks by default, how they group, and which are new. Candidates are AgentSessionProjectCandidate (contracts).
import { normalizeProjectPathForComparison } from "../palette/addProject/addProjectLogic";

export type AgentSessionSource = "claudeAgent" | "codex" | "pi";
export const AGENT_SESSION_SOURCES: readonly AgentSessionSource[] = ["claudeAgent", "codex", "pi"];
export const IMPORT_SOURCE_NAMES: Record<AgentSessionSource, string> = { claudeAgent: "Claude Code", codex: "Codex", pi: "Pi" };
export const IMPORT_SOURCES_LABEL = "Claude Code, Codex, and Pi";
export const SCAN_LIMIT_MESSAGE = "Scan limit reached. Some projects or conversations may be missing.";
export const IMPORT_PERMISSION_MESSAGE = "This connection cannot import projects or thread history.";

export interface ImportCandidate {
  path: string;
  title: string;
  projectId?: string;
  sources: AgentSessionSource[];
  threadCount: number;
  lastActiveAt: string | null;
  alreadyImported: boolean;
  git?: { remoteKey: string | null; repository: string | null } | null;
}

export interface AgentSessionScan { candidates: ImportCandidate[]; scannedAt: string; truncated: boolean }

const RECENT_PROJECT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SELECTION_MIN_THREADS = 3;

type Dict = Record<string, unknown>;
const dict = (value: unknown): Dict | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dict) : null);

/** AgentSessionScanResult, read defensively. */
export function readAgentSessionScan(value: unknown): AgentSessionScan | null {
  const scan = dict(value);
  if (!scan || !Array.isArray(scan.candidates)) return null;
  const candidates: ImportCandidate[] = [];
  for (const raw of scan.candidates) {
    const item = dict(raw);
    if (!item || typeof item.path !== "string" || typeof item.title !== "string") continue;
    const git = dict(item.git);
    candidates.push({
      path: item.path,
      title: item.title,
      ...(typeof item.projectId === "string" ? { projectId: item.projectId } : {}),
      sources: Array.isArray(item.sources) ? item.sources.filter((source): source is AgentSessionSource => AGENT_SESSION_SOURCES.includes(source as AgentSessionSource)) : [],
      threadCount: typeof item.threadCount === "number" ? item.threadCount : 0,
      lastActiveAt: typeof item.lastActiveAt === "string" ? item.lastActiveAt : null,
      alreadyImported: item.alreadyImported === true,
      ...(item.git === null ? { git: null } : git ? { git: { remoteKey: typeof git.remoteKey === "string" ? git.remoteKey : null, repository: typeof git.repository === "string" ? git.repository : null } } : {}),
    });
  }
  return { candidates, scannedAt: typeof scan.scannedAt === "string" ? scan.scannedAt : "", truncated: scan.truncated === true };
}

/** The candidates worth importing by default: a repository with 3+ threads active in the last 30 days. */
export function partitionOnboardingProjects<T extends ImportCandidate>(candidates: readonly T[], now = Date.now()) {
  const cutoff = now - RECENT_PROJECT_WINDOW_MS;
  return {
    available: candidates,
    recent: candidates.filter((candidate) => {
      if (candidate.git === null) return false;
      if (candidate.threadCount < DEFAULT_SELECTION_MIN_THREADS) return false;
      if (candidate.lastActiveAt === null) return false;
      const at = Date.parse(candidate.lastActiveAt);
      return at >= cutoff && at <= now;
    }),
  };
}

export interface OnboardingProjectGroup<T> { key: string; label: string; repository: string | null; candidates: T[]; threadCount: number; lastActiveAt: string | null }

const latest = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a > b ? a : b);

/** Repositories (grouped by remote, newest first) and the folders that are not repositories. */
export function groupOnboardingProjects<T extends Pick<ImportCandidate, "path" | "title" | "git" | "threadCount" | "lastActiveAt">>(candidates: readonly T[]) {
  const groups = new Map<string, OnboardingProjectGroup<T>>();
  const other: T[] = [];
  for (const candidate of candidates) {
    if (candidate.git === null) { other.push(candidate); continue; }
    const git = candidate.git ?? { remoteKey: null, repository: null };
    const key = git.remoteKey === null ? `path:${candidate.path}` : `remote:${git.remoteKey}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { key, label: git.repository ?? candidate.title, repository: git.repository, candidates: [candidate], threadCount: candidate.threadCount, lastActiveAt: candidate.lastActiveAt });
      continue;
    }
    existing.candidates.push(candidate);
    existing.threadCount += candidate.threadCount;
    existing.lastActiveAt = latest(existing.lastActiveAt, candidate.lastActiveAt);
  }
  const repositories = [...groups.values()].sort((left, right) => {
    if (left.lastActiveAt === right.lastActiveAt) return left.label.localeCompare(right.label);
    if (left.lastActiveAt === null) return 1;
    if (right.lastActiveAt === null) return -1;
    return right.lastActiveAt.localeCompare(left.lastActiveAt);
  });
  return { repositories, other };
}

/** The server's project match wins; else a live project at the same path; else the candidate is not a project yet. */
export function resolveOnboardingProjectId(projects: ReadonlyArray<{ id: string; workspaceRoot: string }>, candidate: Pick<ImportCandidate, "path" | "projectId">): string | null {
  if (candidate.projectId !== undefined) return candidate.projectId;
  const path = normalizeProjectPathForComparison(candidate.path);
  return projects.find((project) => normalizeProjectPathForComparison(project.workspaceRoot) === path)?.id ?? null;
}

export function isNewOnboardingProject(projects: ReadonlyArray<{ workspaceRoot: string }>) {
  const roots = new Set(projects.map((project) => normalizeProjectPathForComparison(project.workspaceRoot)));
  return (candidate: Pick<ImportCandidate, "path" | "projectId">) => {
    if (candidate.projectId !== undefined) return false;
    const path = normalizeProjectPathForComparison(candidate.path);
    return path.length === 0 || !roots.has(path);
  };
}

export function splitOnboardingProjectPath(path: string): { name: string; parent: string } {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (trimmed.length === 0) return { name: path, parent: "" };
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index < 0 ? { name: trimmed, parent: "" } : { name: trimmed.slice(index + 1), parent: trimmed.slice(0, index + 1) };
}

/** The footer's Start label with an import (WelcomePage). */
export function startLabel(input: { importing: boolean; selected: number; newCount: number }): string {
  if (input.importing) return input.selected > 0 ? "Importing…" : "Starting…";
  if (input.newCount > 0) return `Import ${input.newCount} ${input.newCount === 1 ? "project" : "projects"} and start`;
  return input.selected > 0 ? "Import threads and start" : "Start";
}

/** The warning after an import that left threads behind. */
export function importWarning(input: { importedThreads: number; skippedThreads: number }): string {
  const plural = (n: number) => (n === 1 ? "thread" : "threads");
  if (input.importedThreads > 0 && input.skippedThreads > 0) return `Imported ${input.importedThreads} ${plural(input.importedThreads)}. ${input.skippedThreads} ${plural(input.skippedThreads)} could not be imported.`;
  if (input.skippedThreads > 0) return `${input.skippedThreads} ${input.skippedThreads === 1 ? "thread could" : "threads could"} not be imported.`;
  if (input.importedThreads > 0) return `Imported ${input.importedThreads} ${plural(input.importedThreads)}. Some thread history could not be imported.`;
  return "Could not import thread history.";
}
