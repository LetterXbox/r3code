// Whether this client may operate the preview: the environment grants the `preview:operate` scope (AuthPreviewOperateScope,
// read with useEnvironmentScope / readEnvironmentScope in the reference). Without it the reference renders no preview and
// its preview.* commands do nothing; the scope comes from the environment's session (`GET /api/auth/session`), as the
// providers and usage pages read theirs. A legacy server that lists only `orchestration:operate` grants it too (legacyParents).
import { effect, signal, untracked } from "nsh";
import { fetchSessionGrant, parseSessionGrant, sessionGrantsScope } from "../../backend/providers";
import { backendBearer, backendConnectionGeneration, backendStatus, backendUrl } from "../../store";

export const PREVIEW_OPERATE_SCOPE = "preview:operate";

/** unknown: the session has not answered (the reference's scope reads false until it does); denied: it answered without the scope. */
export type PreviewScopeState = "unknown" | "granted" | "denied";

const state = signal<PreviewScopeState>("unknown");
const overridden = signal<PreviewScopeState | null>(null);
/** The environment and session the current answer came from. */
let answeredFor = "";

/** Tests choose the answer without a session behind it; null goes back to the environment's. */
export function overridePreviewScope(next: PreviewScopeState | null) {
  overridden.set(next);
}

export function previewScopeState(): PreviewScopeState {
  return overridden() ?? state();
}

/** `canOperatePreview` (chatRouteCommands.ts, PreviewPanel.tsx). */
export function canOperatePreview(): boolean {
  return previewScopeState() === "granted";
}

/** Reads the session's grant while the caller lives, and again on a new connection. */
export function watchPreviewScope() {
  effect(() => {
    const connected = backendStatus() === "connected";
    void backendConnectionGeneration();
    const url = backendUrl();
    const bearer = backendBearer();
    // A dropped connection keeps the last answer for the same environment and session: going back to "unknown" unmounted
    // every browser page (a reload that lost its state) each time the socket reconnected. The next connection asks again.
    const asked = `${url}\n${bearer}`;
    if (!bearer || (!connected && asked !== answeredFor)) { state.set("unknown"); return; }
    if (!connected) return;
    let stale = false;
    untracked(() => {
      void fetchSessionGrant(url, bearer).then((grant) => {
        if (stale) return;
        const session = grant === null ? null : parseSessionGrant(grant);
        state.set(session !== null && sessionGrantsScope(session, PREVIEW_OPERATE_SCOPE) ? "granted" : "denied");
        answeredFor = asked;
      }).catch(() => { if (!stale) { state.set("unknown"); answeredFor = ""; } });
    });
    return () => { stale = true; };
  });
}

/** PreviewPanel's message for a client without the scope. */
export const PREVIEW_SCOPE_MESSAGE = "Pair this client again with preview access to control browser previews.";
