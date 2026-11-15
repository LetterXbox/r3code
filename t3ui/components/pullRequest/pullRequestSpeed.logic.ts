// Quick actions on a list row (PullRequestSpeedActions.tsx's runner): Close, Merge, Ready for review and Reopen
// run at once, without opening the pull request. The web shows them while Shift is held over the list.
import { signal } from "nsh";
import { actionPayload, allowedMergeMethods, type MergeMethod } from "./pullRequestActions.logic";
import { parseDetail } from "./pullRequestDetail.logic";
import type { PullRequestQuickAction } from "./pullRequestList.logic";

/** Whether Shift (alone) is held over the list. A native view reports modifiers with the mouse, so it follows the pointer. */
export const speedMode = signal(false);

export function followSpeedMode(event: { modifiers: { shift: boolean; control: boolean; alt: boolean; platform: boolean } }) {
  const next = event.modifiers.shift && !event.modifiers.control && !event.modifiers.alt && !event.modifiers.platform;
  if (speedMode() !== next) speedMode.set(next);
}

export const QUICK_ACTION_LABEL: Record<PullRequestQuickAction, string> = { close: "Close", merge: "Merge", ready: "Ready for review", reopen: "Reopen" };
const QUICK_ACTION_DONE: Record<PullRequestQuickAction, string> = { close: "Closed", merge: "Merged", ready: "Marked ready for review", reopen: "Reopened" };
export const quickActionDone = (action: PullRequestQuickAction) => QUICK_ACTION_DONE[action];

export interface QuickActionTarget { projectId: string; host?: string; repository: string; number: number }

/** pullRequestDetail.logic.ts resolvePullRequestMergeMethod: current, then the project default, then the last selected. */
export function resolveMergeMethod(allowed: readonly MergeMethod[], current: MergeMethod | null, projectDefault: MergeMethod | undefined, lastSelected: MergeMethod | undefined): MergeMethod {
  for (const method of [current, projectDefault, lastSelected]) if (method && allowed.includes(method)) return method;
  return allowed[0] ?? "merge";
}

/**
 * Runs one quick action. Merge is client-runtime pullRequests.ts runAction with resolveMergeMethod: a fresh detail
 * (allowStale false) must be open, not a draft, mergeable by host and viewer; a stacked pull request is refused; the method
 * follows the project default; the action asks for the summary reply.
 */
export async function runQuickAction(
  request: (method: string, payload: unknown) => Promise<unknown>, target: QuickActionTarget, action: PullRequestQuickAction,
  preferences: { projectDefault?: MergeMethod; lastSelected?: MergeMethod } = {},
): Promise<void> {
  const ref = { projectId: target.projectId, ...(target.host ? { host: target.host } : {}), repository: target.repository, number: target.number };
  let method: MergeMethod | undefined;
  if (action === "merge") {
    const detail = parseDetail(await request("pullRequests.detail", { ...ref, allowStale: false }));
    if (detail.state !== "open" || detail.isDraft || !detail.capabilities.actions.includes("merge") || !detail.permissions.actions.includes("merge")) {
      throw new Error("This pull request cannot be merged.");
    }
    if (detail.capabilities.stackActions) {
      const stack = await request("pullRequests.stack", { ...ref, allowStale: false });
      if (stack !== null && stack !== undefined) throw new Error("Open this pull request to merge its stack.");
    }
    const allowed = allowedMergeMethods({ capabilities: detail.capabilities, mergeCapabilities: detail.mergeCapabilities });
    if (allowed.length === 0) throw new Error("No merge method is available for this repository.");
    method = resolveMergeMethod(allowed, null, preferences.projectDefault, preferences.lastSelected);
  }
  await request("pullRequests.runAction", { ...actionPayload(ref, action, method), replyWithSummary: true });
}
