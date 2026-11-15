// ServerUpdateState (client-runtime state/server.ts) and the composer notice it drives
// (useSystemComposerBanners.tsx): shown while an update runs or after it failed, never while idle.
import { signal } from "nsh";
import type { BannerAction, BannerItem } from "./bannerTypes";

export type ServerUpdateStage = "downloading" | "installing" | "resuming";
export type ServerUpdateState =
  | { status: "idle" }
  | { status: "running"; stage: ServerUpdateStage; fromVersion: string; targetVersion: string }
  | { status: "failed"; stage: ServerUpdateStage; fromVersion: string; targetVersion: string; message: string };

/** The server-update progress the composer notice shows (serverEnvironment.updateStateAtom); set by runServerUpdate. */
export const serverUpdateState = signal<ServerUpdateState>({ status: "idle" });

/** serverUpdateStageLabel */
export function serverUpdateStageLabel(stage: ServerUpdateStage): string {
  return stage === "resuming" ? "Restarting\u2026" : "Downloading\u2026";
}

export function serverUpdateItem(input: {
  state: ServerUpdateState; failureDismissed: boolean; automaticEnvironment: boolean; serverLabel: string;
  canRetry: boolean; onRetry: () => void; onDismiss: () => void;
}): BannerItem | null {
  const { state } = input;
  // An available update is offered by the sidebar's update pill; the composer only shows one that is running or failed.
  if (input.automaticEnvironment || state.status === "idle" || input.failureDismissed) return null;
  const failed = state.status === "failed";
  const actions: BannerAction[] = failed && input.canRetry ? [{ id: "retry", label: "Retry", tone: "button", run: input.onRetry }] : [];
  return {
    id: "server-version",
    variant: failed ? "error" : "default",
    group: "environment",
    icon: failed ? "circle-alert" : "download",
    title: `${failed ? "Could not update" : "Updating"} ${input.serverLabel}`,
    description: failed ? state.message : serverUpdateStageLabel(state.stage),
    actions,
    ...(failed ? { dismissLabel: "Dismiss update notice", onDismiss: input.onDismiss } : {}),
  };
}
