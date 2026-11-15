// When the built-in slash commands and the compact-before-send offer are available
// (ChatView.tsx: sideChatDisabledReason, freshSessionCommandAvailable, compactThreadUnavailable,
// resumeCompactionTokens). Pure, so the rules are tested apart from the store.

/** Why `/side` and `/btw` cannot start a side chat now, or null when they can. */
export function sideChatDisabledReason(input: {
  isSideChat: boolean; isSubagent: boolean; environmentKnown: boolean; environmentSupportsSideChats: boolean; isServerThread: boolean;
}): string | null {
  if (input.isSideChat) return "Side chats cannot start side chats.";
  if (input.isSubagent) return "Subagent threads cannot start side chats.";
  if (!input.environmentKnown) return "Side chats are not ready yet. Try again in a moment.";
  if (!input.environmentSupportsSideChats) return "Update this environment's R3 Code server to use side chats.";
  if (!input.isServerThread) return "Side chats start after the first message.";
  return null;
}

/** `/clear` needs a started conversation, a server that honours `freshContext`, and no pending question or approval. */
export function freshSessionAvailable(input: { messageCount: number; environmentSupportsFreshContext: boolean; pendingRequests: boolean }): boolean {
  return input.messageCount > 0 && input.environmentSupportsFreshContext && !input.pendingRequests;
}

/** A manual `/compact` can run: a started server thread whose provider offers it, with nothing running or pending. */
export function compactThreadAvailable(input: {
  isServerThread: boolean; hasMessages: boolean; providerOffersCompact: boolean; running: boolean; pendingRequests: boolean; connected: boolean;
}): boolean {
  return input.connected && input.isServerThread && input.hasMessages && input.providerOffersCompact && !input.running && !input.pendingRequests;
}

/** Compact-before-send is offered on top of availability, unless the setting is off, a held queue waits, or the user kept the history. */
export function resumeCompactionOffered(input: {
  compactAvailable: boolean; idleCompactionMode: string; hasHeldQueue: boolean; usageOffered: boolean;
}): boolean {
  return input.compactAvailable && input.idleCompactionMode !== "off" && !input.hasHeldQueue && input.usageOffered;
}

/** resolveIdleCompaction: the provider instance's own mode, else the environment's. */
export function idleCompactionMode(settings: Record<string, unknown> | null, instanceId: string): string {
  const instances = (settings?.providerInstances ?? {}) as Record<string, { config?: { idleCompaction?: unknown } } | undefined>;
  const override = Object.hasOwn(instances, instanceId) ? instances[instanceId]?.config?.idleCompaction : undefined;
  if (typeof override === "string" && override !== "default") return override;
  if (typeof settings?.idleCompaction === "string") return settings.idleCompaction;
  if (typeof settings?.compactIdleThreads === "string") return settings.compactIdleThreads;
  return settings?.compactIdleThreads === true ? "beforeCacheExpires" : "onReturn";
}

type ProviderRecord = Record<string, unknown>;
const recordText = (value: unknown) => (typeof value === "string" && value ? value : null);
const continuationGroupOf = (record: ProviderRecord) => {
  const continuation = record.continuation;
  return continuation && typeof continuation === "object" ? recordText((continuation as Record<string, unknown>).groupKey) : null;
};
/** providerInstances isSelectableProviderInstanceEntry / isProviderInstancePickerReady over raw snapshots. */
const selectableRecord = (record: ProviderRecord) => record.enabled !== false && record.availability !== "unavailable";
const pickerReadyRecord = (record: ProviderRecord) => selectableRecord(record) && record.status === "ready";

/**
 * compaction.logic.ts hasAvailableCompactionProvider: `/compact` is offered when the provider instance a send would use
 * (the selected one when selectable, else the first ready one) among the driver's instances - narrowed to the started
 * thread's continuation group - lists `compact` in its slash commands.
 */
export function hasAvailableCompactionProvider(input: { providers: readonly ProviderRecord[]; driverKind: string | null; instanceId: string | null; lockedInstanceId: string | null }): boolean {
  if (!input.driverKind) return false;
  const driverProviders = input.providers.filter((provider) => provider.driver === input.driverKind);
  const lockedGroup = input.lockedInstanceId ? continuationGroupOf(driverProviders.find((provider) => provider.instanceId === input.lockedInstanceId) ?? {}) : null;
  const compatible = lockedGroup ? driverProviders.filter((provider) => continuationGroupOf(provider) === lockedGroup) : driverProviders;
  const requested = input.instanceId ? compatible.find((provider) => provider.instanceId === input.instanceId) : undefined;
  const chosen = requested && selectableRecord(requested) ? requested
    : compatible.find(pickerReadyRecord) ?? compatible.find((provider) => selectableRecord(provider) && provider.status !== "error");
  const commands = chosen?.slashCommands;
  return Array.isArray(commands) && commands.some((command) => command && typeof command === "object" && (command as Record<string, unknown>).name === "compact");
}

/** deriveLockedProvider's instance: a started thread (a run or provider session) is locked to its model selection's instance. */
export function lockedCompactionInstanceId(projection: Record<string, unknown> | null): string | null {
  if (!projection) return null;
  const runs = Array.isArray(projection.runs) ? projection.runs : [];
  const sessions = Array.isArray(projection.providerSessions) ? projection.providerSessions : [];
  if (runs.length === 0 && sessions.length === 0) return null;
  const thread = projection.thread && typeof projection.thread === "object" ? (projection.thread as Record<string, unknown>) : {};
  const runtime = thread.runtime && typeof thread.runtime === "object" ? (thread.runtime as Record<string, unknown>) : {};
  const selection = thread.modelSelection && typeof thread.modelSelection === "object" ? (thread.modelSelection as Record<string, unknown>) : {};
  return recordText(runtime.providerInstanceId) ?? recordText(selection.instanceId);
}
