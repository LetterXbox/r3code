// What the root coordinators read from the connected server: the lifecycle stream (`subscribeServerLifecycle`: the welcome
// the first-run gate reads and the legacy thread migration) and the config stream's `lastEventLoopStall`. The web keeps both
// in atoms (primaryServerWelcomeAtom, primaryServerLegacyThreadMigrationAtom, environmentServerConfigsAtom); here one
// subscription per connection feeds these signals.
import { effect, signal, untracked } from "nsh";
import { backendConnectionGeneration, backendStatus, onServerConfigEvent, subscribeBackend } from "../../store";
import { retryingStream } from "../../environments/environmentSession";

export interface ServerWelcome {
  environmentId: string | null;
  cwd: string | null;
  projectName: string | null;
  bootstrapStatus: "pending" | "complete" | null;
  bootstrapProjectId: string | null;
  bootstrapThreadId: string | null;
  bootstrapProjectCreated: boolean | null;
  bootstrapThreadCreated: boolean | null;
}

export interface LegacyThreadMigration { status: "running" | "complete"; totalThreadCount: number }

export interface EventLoopStall { detectedAt: string; durationMs: number; loadAverage?: number; cpuCount: number }

function dict(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const optionalString = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
const optionalBoolean = (value: unknown) => (typeof value === "boolean" ? value : null);

/** ServerLifecycleWelcomePayload, as far as the gate reads it. */
export function readWelcome(payload: unknown): ServerWelcome | null {
  const value = dict(payload);
  if (!value) return null;
  const environment = dict(value.environment);
  const status = value.bootstrapStatus;
  return {
    environmentId: optionalString(environment?.environmentId),
    cwd: optionalString(value.cwd),
    projectName: optionalString(value.projectName),
    bootstrapStatus: status === "pending" || status === "complete" ? status : null,
    bootstrapProjectId: optionalString(value.bootstrapProjectId),
    bootstrapThreadId: optionalString(value.bootstrapThreadId),
    bootstrapProjectCreated: optionalBoolean(value.bootstrapProjectCreated),
    bootstrapThreadCreated: optionalBoolean(value.bootstrapThreadCreated),
  };
}

export function readLegacyMigration(payload: unknown): LegacyThreadMigration | null {
  const value = dict(payload);
  if (!value || (value.status !== "running" && value.status !== "complete")) return null;
  return { status: value.status, totalThreadCount: typeof value.totalThreadCount === "number" ? value.totalThreadCount : 0 };
}

/** ServerEventLoopStall of a config snapshot, or null when the server reports none. */
export function readEventLoopStall(config: unknown): EventLoopStall | null {
  const stall = dict(dict(config)?.lastEventLoopStall);
  if (!stall || typeof stall.detectedAt !== "string" || typeof stall.durationMs !== "number" || typeof stall.cpuCount !== "number") return null;
  return { detectedAt: stall.detectedAt, durationMs: stall.durationMs, cpuCount: stall.cpuCount, ...(typeof stall.loadAverage === "number" ? { loadAverage: stall.loadAverage } : {}) };
}

const welcomeSignal = signal<ServerWelcome | null>(null);
const migrationSignal = signal<LegacyThreadMigration | null>(null);
const stallSignal = signal<EventLoopStall | null>(null);
const configSeenSignal = signal(false);

export const serverWelcome = () => welcomeSignal();
export const legacyThreadMigration = () => migrationSignal();
export const serverEventLoopStall = () => stallSignal();
/** True once the connected server's config snapshot arrived (primaryServerConfigAtom is non-null in the web). */
export const serverConfigReceived = () => configSeenSignal();

/** Feeds one lifecycle stream event (ServerLifecycleStreamEvent); returns what kind of event it was. */
export function observeLifecycleEvent(event: unknown): "welcome" | "ready" | "legacyThreadMigration" | null {
  const value = dict(event);
  if (!value) return null;
  if (value.type === "welcome") { welcomeSignal.set(readWelcome(value.payload)); return "welcome"; }
  if (value.type === "legacyThreadMigration") { migrationSignal.set(readLegacyMigration(value.payload)); return "legacyThreadMigration"; }
  if (value.type === "ready") return "ready";
  return null;
}

/** Feeds one config stream event (a snapshot carries `config`, an update `payload`). */
export function observeConfigEvent(event: unknown) {
  const value = dict(event);
  if (!value) return;
  if (value.type === "snapshot") {
    configSeenSignal.set(true);
    stallSignal.set(readEventLoopStall(value.config));
  }
}

export function resetServerStreams() {
  welcomeSignal.set(null);
  migrationSignal.set(null);
  stallSignal.set(null);
  configSeenSignal.set(false);
}

let installed = false;

/** Follows the connected server's lifecycle and config streams. Once, at startup. */
export function installServerStreams() {
  if (installed) return;
  installed = true;
  onServerConfigEvent(observeConfigEvent);
  let seenGeneration = -1;
  effect(() => {
    const connected = backendStatus() === "connected";
    const generation = backendConnectionGeneration();
    // A different connection is a different server: what the last one said does not carry over.
    if (generation !== seenGeneration) {
      const first = seenGeneration === -1;
      seenGeneration = generation;
      if (!first) untracked(resetServerStreams);
    }
    if (!connected) return;
    // Config events come from the store's own config stream (onServerConfigEvent below): a second subscription made the
    // server send every config snapshot twice.
    const stops = untracked(() => [
      // rpc/client.ts: the lifecycle stream resubscribes when it fails or ends while the connection stays.
      retryingStream(subscribeBackend, "subscribeServerLifecycle", {}, observeLifecycleEvent),
    ]);
    return () => { for (const stop of stops) stop(); };
  });
}
