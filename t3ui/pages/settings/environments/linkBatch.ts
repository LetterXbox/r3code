// Batch linking helpers (packages/client-runtime/src/linkBatch.ts + LinkSeveralEnvironments.tsx):
// links several connected saved environments at once by minting an ephemeral one-use pairing code on
// each machine and handing it to `peerLinks.link` without ever storing or logging any pairing code.
import { loadSessionBearer } from "../../../backend/sessionCredential";
import { backendBearer, backendUrl } from "../../../store";
import { environmentConfigs, environmentConnections, type EnvironmentConnection } from "../../../environments/connectionManager";
import type { EnvironmentMachineKind } from "./MachineIcon";
import { resolveEnvironmentMachineKind } from "./MachineIcon";
import { savedEnvironments, type SavedEnvironment } from "./savedEnvironments";

export type PeerLinkFailureKind = "unreachable" | "code_refused" | "wrong_environment" | "other";
export type LinkBatchBlock = "links_unknown" | "linked" | "not_connected" | "no_access" | "no_address";
export type LinkListState = "loading" | "failed" | "loaded";
export type LinkBatchFailure = PeerLinkFailureKind | "no_code";
export type LinkBatchOutcome =
  | { readonly kind: "linked" }
  | { readonly kind: "failed"; readonly failure: LinkBatchFailure; readonly detail: string | null };

export interface LinkableMachine {
  environmentId: string;
  label: string;
  urls: string[];
  connected: boolean;
  linked: boolean;
  machine: EnvironmentMachineKind;
  canCreatePairingToken: boolean;
}

export interface LinkBatchCandidate {
  readonly machine: LinkableMachine;
  readonly blocked: LinkBatchBlock | null;
}

const LINK_BATCH_CONCURRENCY = 4;

export function peerLinkFailureKind(error: { reason?: unknown; answeredAs?: unknown }): PeerLinkFailureKind {
  if (error.answeredAs !== undefined) return "wrong_environment";
  if (error.reason === "unreachable" || error.reason === "not_a_t3_environment") return "unreachable";
  if (error.reason === "pairing_rejected") return "code_refused";
  return "other";
}

export function linkListState(query: { readonly data: unknown; readonly error: unknown }): LinkListState {
  return query.data !== null ? "loaded" : query.error !== null ? "failed" : "loading";
}

export function linkBatchCandidates(
  machines: readonly LinkableMachine[],
  links: LinkListState,
): readonly LinkBatchCandidate[] {
  return machines.map((machine) => ({
    machine,
    blocked:
      links !== "loaded"
        ? "links_unknown"
        : machine.linked
          ? "linked"
          : !machine.connected
            ? "not_connected"
            : !machine.canCreatePairingToken
              ? "no_access"
              : machine.urls.length === 0
                ? "no_address"
                : null,
  }));
}

export function linkBatchBlockLabel(blocked: LinkBatchBlock): string {
  switch (blocked) {
    case "links_unknown": return "Not known yet whether it is linked";
    case "linked": return "Already linked";
    case "not_connected": return "This app is not connected to it";
    case "no_access": return "Your session there cannot create pairing codes";
    case "no_address": return "No address another machine can reach";
  }
}

export function linkBatchFailureLabel(failure: LinkBatchFailure): string {
  switch (failure) {
    case "unreachable": return "Unreachable";
    case "code_refused": return "Pairing code refused";
    case "wrong_environment": return "Another environment answered";
    case "no_code": return "Could not get a pairing code there";
    case "other": return "Could not link";
  }
}

/** Only the linking environment's own PeerLinkError passes its message through: anything else may carry the request and code. */
export function linkFailureFromCause(cause: unknown): LinkBatchOutcome {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "tag" in cause &&
    (cause as { tag?: unknown }).tag === "PeerLinkError" &&
    "message" in cause &&
    typeof (cause as { message?: unknown }).message === "string"
  ) {
    const err = cause as { reason?: unknown; answeredAs?: unknown; message: string };
    return { kind: "failed", failure: peerLinkFailureKind(err), detail: err.message };
  }
  const candidates: unknown[] = [cause];
  if (typeof cause === "object" && cause !== null && "detail" in cause) {
    candidates.unshift((cause as { detail?: unknown }).detail);
  }
  for (const candidate of candidates) {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "_tag" in candidate &&
      (candidate as { _tag?: unknown })._tag === "PeerLinkError" &&
      "reason" in candidate &&
      "message" in candidate &&
      typeof (candidate as { message?: unknown }).message === "string"
    ) {
      const error = candidate as { reason?: unknown; answeredAs?: unknown; message: string };
      return { kind: "failed", failure: peerLinkFailureKind(error), detail: error.message };
    }
  }
  return { kind: "failed", failure: "other", detail: null };
}

export async function runLinkBatch(input: {
  readonly machines: readonly Pick<LinkableMachine, "environmentId" | "label" | "urls">[];
  readonly access: string;
  readonly mint: (environmentId: string, access: string) => Promise<{ ok: true; code: string } | { ok: false }>;
  readonly link: (payload: {
    url: string;
    alternateUrls?: string[];
    expectedEnvironmentId: string;
    expectedLabel: string;
    pairingCode: string;
    access: string;
  }) => Promise<{ ok: true } | { ok: false; cause: unknown }>;
  /** Called once, at the end: listing probes every linked machine, so `link` must not refresh. */
  readonly refreshLinks: () => void;
  readonly onOutcome?: (environmentId: string, outcome: LinkBatchOutcome) => void;
}): Promise<ReadonlyMap<string, LinkBatchOutcome>> {
  const outcomes = new Map<string, LinkBatchOutcome>();
  const linkOne = async (machine: Pick<LinkableMachine, "environmentId" | "label" | "urls">): Promise<LinkBatchOutcome> => {
    const [url, ...alternateUrls] = machine.urls;
    if (url === undefined) return { kind: "failed", failure: "unreachable", detail: null };
    const minted = await input.mint(machine.environmentId, input.access);
    if (!minted.ok) return { kind: "failed", failure: "no_code", detail: null };
    const linked = await input.link({
      url,
      ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
      expectedEnvironmentId: machine.environmentId,
      expectedLabel: machine.label,
      pairingCode: minted.code,
      access: input.access,
    });
    return linked.ok ? { kind: "linked" } : linkFailureFromCause(linked.cause);
  };
  const queue = [...input.machines];
  const worker = async () => {
    for (let machine = queue.shift(); machine !== undefined; machine = queue.shift()) {
      const outcome = await linkOne(machine).catch((): LinkBatchOutcome => ({ kind: "failed", failure: "other", detail: null }));
      outcomes.set(machine.environmentId, outcome);
      input.onOutcome?.(machine.environmentId, outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LINK_BATCH_CONCURRENCY, Math.max(1, queue.length)) }, worker));
  if ([...outcomes.values()].some((outcome) => outcome.kind === "linked")) input.refreshLinks();
  return outcomes;
}

export function linkBatchSummary(outcomes: ReadonlyMap<string, LinkBatchOutcome>): { linked: number; failed: string[] } {
  const failed = [...outcomes].flatMap(([environmentId, outcome]) => (outcome.kind === "failed" ? [environmentId] : []));
  return { linked: outcomes.size - failed.length, failed };
}

function httpBase(socketUrl: string): string {
  const url = new URL(socketUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function peerReachableUrls(raw: string): string[] {
  try {
    const base = httpBase(raw);
    const host = new URL(base).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return [];
    return [base];
  } catch {
    return [];
  }
}

export function discoverLinkableMachines(input: {
  hostKey: string;
  links: readonly { environmentId: string }[] | null;
  primaryUrl?: string;
  saved?: readonly SavedEnvironment[];
  connections?: Record<string, EnvironmentConnection>;
  configs?: Record<string, Record<string, unknown>>;
}): LinkableMachine[] {
  const primary = input.primaryUrl ?? backendUrl();
  const saved = input.saved ?? savedEnvironments();
  const connections = input.connections ?? environmentConnections();
  const configs = input.configs ?? environmentConfigs();
  const linkedIds = new Set((input.links ?? []).map((link) => link.environmentId));
  const machines: LinkableMachine[] = [];
  for (const env of saved) {
    if (!env.enabled || env.id === input.hostKey || (input.hostKey === "primary" && env.url === primary)) continue;
    const config = record(configs[env.id]);
    const environment = record(config?.environment);
    const environmentId = typeof environment?.environmentId === "string" ? environment.environmentId : env.id;
    const connected = connections[env.id]?.phase === "connected";
    const urls = [...new Set([env.url, ...(env.alternateUrls ?? [])].flatMap(peerReachableUrls))];
    const capabilities = record(environment?.capabilities);
    const machine = resolveEnvironmentMachineKind(config as { environment?: { platform?: { machine?: unknown } } | null; settings?: { environmentIcon?: unknown } | null } | null);
    machines.push({
      environmentId,
      label: env.label || (typeof environment?.label === "string" && environment.label ? environment.label : env.url),
      urls,
      connected,
      linked: linkedIds.has(environmentId),
      machine,
      canCreatePairingToken: connected && (capabilities === null || capabilities.accessWrite !== false) && !env.relay,
    });
  }
  return machines;
}

export async function mintPairingCodeForSavedEnvironment(
  environmentId: string,
  access: string,
  deps?: {
    saved?: readonly SavedEnvironment[];
    configs?: Record<string, Record<string, unknown>>;
    primaryUrl?: string;
    primaryBearer?: string | null;
    loadBearer?: (url: string) => Promise<string | null>;
    fetcher?: typeof fetch;
  },
): Promise<{ ok: true; code: string } | { ok: false }> {
  const saved = deps?.saved ?? savedEnvironments();
  const configs = deps?.configs ?? environmentConfigs();
  const match = saved.find((env) => {
    const configEnv = record(configs[env.id]?.environment);
    return env.id === environmentId || configEnv?.environmentId === environmentId;
  });
  const targetUrl = match?.url ?? (environmentId === "primary" ? (deps?.primaryUrl ?? backendUrl()) : null);
  if (!targetUrl) return { ok: false };
  const bearer = environmentId === "primary"
    ? (deps?.primaryBearer ?? backendBearer())
    : await (deps?.loadBearer ?? loadSessionBearer)(targetUrl);
  if (!bearer) return { ok: false };
  try {
    const response = await (deps?.fetcher ?? fetch)(`${httpBase(targetUrl)}/api/auth/pairing-token`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ access }),
    });
    if (!response.ok) return { ok: false };
    const json = record(await response.json());
    return typeof json?.credential === "string" && json.credential.length > 0 ? { ok: true, code: json.credential } : { ok: false };
  } catch {
    return { ok: false };
  }
}
