// cloud/t3ConnectState.ts resolveT3ConnectTurnOn, and useEnvironmentScope for the primary environment's relay permissions:
// the shared pieces the MCP wizard, the Welcome phone band and the onboarding dialog read.
import { accessSession, loadAccessSession, sessionHolds } from "../pages/settings/environments/accessSession";
import { backendStatus } from "../store";

export const RELAY_READ_SCOPE = "relay:read";
export const RELAY_WRITE_SCOPE = "relay:write";
export const ACCESS_WRITE_SCOPE = "access:write";

/** useEnvironmentScope: false until the session is read; reading it starts the read once per connection. */
export function primaryEnvironmentScope(scope: string): boolean {
  const session = accessSession();
  if (session.status === "idle" && backendStatus() === "connected") queueMicrotask(() => { if (accessSession().status === "idle") void loadAccessSession(); });
  return session.status === "ready" && sessionHolds(session, scope);
}

/** True once the primary session has been read (AuthSessionState loaded), whatever it holds. */
export const primarySessionScopesKnown = () => accessSession().status === "ready" || accessSession().status === "failed";

export type T3ConnectTurnOn = { kind: "here" } | { kind: "policy"; reason: string } | { kind: "on-host" };

/** resolveT3ConnectTurnOn, verbatim. */
export function resolveT3ConnectTurnOn(input: { desktopApp: boolean; linkableHere: boolean; cloudConfigured: boolean; canReadRelay: boolean; canWriteRelay: boolean; connectDenial: string | undefined }): T3ConnectTurnOn {
  if (input.connectDenial !== undefined) return { kind: "policy", reason: input.connectDenial };
  return input.desktopApp && input.linkableHere && input.cloudConfigured && input.canReadRelay && input.canWriteRelay ? { kind: "here" } : { kind: "on-host" };
}
