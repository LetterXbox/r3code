// What the stack menu offers (PullRequestStackMenu.tsx): which layers a merge or rebase covers, and when either is
// held back. A native stack is a chain of pull requests each based on the one below.
import type { PullRequestStackData, StackLayer } from "./pullRequestDetail.logic";

export interface StackPlan {
  position: number;
  selected: StackLayer | undefined;
  top: StackLayer | undefined;
  unmerged: StackLayer[];
  mergeLayers: StackLayer[];
  mergeDisabled: boolean;
  rebaseDisabled: boolean;
  /** Every layer being merged must be open and ready for review. */
  mergeBlockedByLayer: boolean;
}

export function planStack(stack: PullRequestStackData, currentNumber: number, options: { pending?: boolean; stale?: boolean } = {}): StackPlan {
  const pending = options.pending === true;
  const stale = options.stale === true;
  const top = stack.layers[stack.layers.length - 1];
  const unmerged = stack.layers.filter((layer) => layer.state !== "merged");
  const hasClosed = unmerged.some((layer) => layer.state !== "open");
  const position = stack.layers.findIndex((layer) => layer.number === currentNumber) + 1;
  const mergeLayers = stack.layers.slice(0, position).filter((layer) => layer.state !== "merged");
  const selected = stack.layers[position - 1];
  const mergeHasClosed = mergeLayers.some((layer) => layer.state !== "open");
  const hasUnknownHead = unmerged.some((layer) => !layer.headSha);
  return {
    position, selected, top, unmerged, mergeLayers,
    mergeDisabled: pending || stale || selected?.state !== "open" || mergeLayers.some((layer) => !layer.headSha) || mergeHasClosed || mergeLayers.length === 0 || mergeLayers.some((layer) => layer.isDraft),
    rebaseDisabled: pending || stale || hasUnknownHead || hasClosed || unmerged.length === 0,
    mergeBlockedByLayer: mergeHasClosed || mergeLayers.some((layer) => layer.isDraft),
  };
}

/** The `expectedStackHeads` and target of a stack merge or rebase, as pullRequests.runAction takes them. */
export function stackActionPayload(
  ref: { projectId: string; host?: string; repository: string; number: number }, stack: PullRequestStackData, plan: StackPlan, action: "merge" | "update-branch", mergeMethod: string,
) {
  const target = action === "merge" ? plan.selected : plan.top;
  if (!target?.headSha) return null;
  const heads = (action === "merge" ? plan.mergeLayers : plan.unmerged).flatMap((layer) => (layer.headSha ? [{ number: layer.number, headSha: layer.headSha }] : []));
  return {
    ...ref, number: target.number, stackNumber: stack.number, expectedStackHeads: heads, action,
    ...(action === "merge" ? { mergeMethod } : { updateMethod: "rebase" }),
  };
}
