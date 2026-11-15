// Raises the connection toast: "<label> is reconnecting" once a reconnect has lasted past the grace period, "<label> is offline"
// with Reconnect when the connection failed with a session to resume, and the pairing prompt when the server refused the
// session. One toast id, so each state replaces the last and a restored connection closes it.
import { effect, signal, untracked } from "nsh";
import { backendBearer, backendConnectionGeneration, backendError, backendStatus, backendUrl, configureBackend, openSettings } from "../../store";
import { serverEnvironment } from "../../pages/settings/settingsState";
import { closeToast, showToast } from "../toast/toastState";
import {
  CONNECTION_NOTICE_ID,
  ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
  connectionNotice,
  connectionPhase,
  type ConnectionPhase,
} from "./connection.logic";

const hasConnected = signal(false);
const graceElapsed = signal(false);
let lastGeneration = -1;
let sessionOverride: boolean | null = null;
/** Tests only: say whether a session credential exists (the store keeps none in a fixture); null restores the real check. */
export function forceConnectionSessionForTest(value: boolean | null) { sessionOverride = value; }

export function environmentLabel(): string {
  const label = serverEnvironment()?.label;
  if (typeof label === "string" && label) return label;
  try { return new URL(backendUrl()).host || "This environment"; } catch { return "This environment"; }
}

/** The phase the web's ConnectionStatusDot would show for the connected environment. */
export function currentConnectionPhase(): ConnectionPhase {
  return connectionPhase(backendStatus(), hasConnected());
}

let installed = false;

export function installConnectionCoordinator() {
  if (installed) return;
  installed = true;
  effect(() => {
    const status = backendStatus();
    const generation = backendConnectionGeneration();
    untracked(() => {
      if (generation !== lastGeneration) { lastGeneration = generation; hasConnected.set(false); }
      if (status === "connected") hasConnected.set(true);
    });
  });
  // A reconnect must hold for the grace period before it is worth a warning.
  effect(() => {
    const phase = currentConnectionPhase();
    if (phase !== "reconnecting") { untracked(() => graceElapsed.set(false)); return; }
    const timer = setTimeout(() => graceElapsed.set(true), ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);
    return () => clearTimeout(timer);
  });
  effect(() => {
    const notice = connectionNotice({ phase: currentConnectionPhase(), label: environmentLabel(), error: backendError(), graceElapsed: graceElapsed(), hasSession: sessionOverride ?? backendBearer() !== null });
    untracked(() => {
      if (!notice) { closeToast(CONNECTION_NOTICE_ID); return; }
      showToast({
        id: notice.id,
        type: notice.variant,
        title: notice.title,
        ...(notice.description ? { description: notice.description } : {}),
        timeoutMs: 0,
        hideCopyButton: true,
        actions: notice.action === "Reconnect"
          ? [{ label: "Reconnect", variant: "outline", run: () => configureBackend(backendUrl()) }]
          : notice.action === "Open Environments"
            ? [{ label: "Open Environments", run: () => { closeToast(CONNECTION_NOTICE_ID); openSettings("/settings/connections"); } }]
            : [],
      });
    });
  });
}
