// ProviderSubagentBar reads the latest runless root execution node, as T3 does.

export interface ProviderSubagentStatus { status: "idle" | "pending" | "running" | "waiting" | "completed" | "interrupted" | "failed" | "cancelled" | "rolled_back"; startedAt: number | null; completedAt: number | null }

const LABELS: Record<ProviderSubagentStatus["status"], string> = { idle: "Idle", pending: "Working", running: "Working", waiting: "Waiting", completed: "Completed", interrupted: "Interrupted", failed: "Failed", cancelled: "Cancelled", rolled_back: "Cancelled" };
const isNodeStatus = (value: unknown): value is ProviderSubagentStatus["status"] => typeof value === "string" && Object.prototype.hasOwnProperty.call(LABELS, value);

export function subagentStatusFor(nodes: readonly Record<string, unknown>[]): ProviderSubagentStatus | null {
  const node = [...nodes].reverse().find((item) => item.kind === "root_turn" && item.runId === null);
  const status = node?.status;
  if (!isNodeStatus(status)) return null;
  const parseTime = (value: unknown) => { const result = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(result) ? result : null; };
  return { status, startedAt: parseTime(node?.startedAt), completedAt: parseTime(node?.completedAt) };
}

export function formatDuration(ms: number): string {
  const total = Math.max(1, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatProviderSubagentStatus(status: ProviderSubagentStatus | null, nowMs: number): string {
  if (status === null) return "Starting";
  const label = LABELS[status.status];
  const live = status.status === "pending" || status.status === "running" || status.status === "waiting";
  if (!live && status.status !== "completed") return label;
  const end = live ? nowMs : status.completedAt;
  if (status.startedAt === null || end === null) return label;
  const elapsed = formatDuration(Math.floor((end - status.startedAt) / 1000) * 1000);
  return live ? `${label} ${elapsed}` : `${label} in ${elapsed}`;
}

export function subagentModelLabel(model: string): string {
  return model;
}
