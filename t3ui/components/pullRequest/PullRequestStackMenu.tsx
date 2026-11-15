// The stack menu in the detail header (PullRequestStackMenu.tsx with PullRequestStackHeader, PullRequestStackLayers
// and PullRequestStackLayerContent): where this layer sits, every layer to jump to, and Merge / Rebase the stack.
import { signal, Text, View } from "nsh";
import { createAnchor, Popup } from "../composer/Popover";
import { confirm, updateToast } from "../toast";
import { showToast } from "../toast";
import { PRIcon } from "./PRIcon";
import type { PullRequestActionsModel } from "./pullRequestActionsModel";
import type { PullRequestStackData, StackLayer } from "./pullRequestDetail.logic";
import { planStack, stackActionPayload } from "./pullRequestStack.logic";
import { resolveState, toneColor, type Scheme } from "./pullRequestPresentation";

const MERGE_HINT = "The host refused the merge. Check that you have write access, that the checks it requires have passed, and that the branch is not conflicting.";
const REBASE_HINT = "The host refused the rebase. A rebase stops at the first commit that does not apply cleanly.";

export function PullRequestStackLayerContent(props: { layer: StackLayer; compact?: boolean; scheme: () => Scheme }) {
  const state = () => resolveState({ state: props.layer.state, isDraft: props.layer.isDraft });
  return (
    <>
      <PRIcon name={state().icon} size={16} tint={toneColor(state().tone, props.scheme())} />
      <View class="min-w-0 flex-1 flex-col">
        <Text class="truncate text-sm text-foreground">{props.layer.title || props.layer.headBranch}</Text>
        <Text class="truncate text-xs text-muted-foreground">{`#${props.layer.number} · ${props.compact ? "" : `${props.layer.headBranch} · `}${state().label}`}</Text>
      </View>
    </>
  );
}

export function PullRequestStackMenu(props: {
  stack: PullRequestStackData;
  currentNumber: number;
  hostLabel: string;
  term: { singular: string; plural: string };
  actions: PullRequestActionsModel;
  scheme: () => Scheme;
  /** The stack was read before and a refresh is running or failed. */
  notice?: () => string | null;
  stale?: () => boolean;
  canMerge: () => boolean;
  canRebase: () => boolean;
  onSelect: (layer: StackLayer) => void;
  onRetry?: () => void;
}) {
  const open = signal(false);
  const anchor = createAnchor();
  const plan = () => planStack(props.stack, props.currentNumber, { pending: props.actions.pending() !== null, stale: props.stale?.() === true });
  const plural = (count: number) => (count === 1 ? props.term.singular : props.term.plural);

  async function act(action: "merge" | "update-branch") {
    open.set(false);
    const layers = action === "merge" ? plan().mergeLayers : plan().unmerged;
    const method = props.actions.mergeMethod();
    const ok = await confirm(
      action === "merge"
        ? `Merge ${layers.length} ${plural(layers.length)}?\nMerge #${props.currentNumber} and its unmerged layers below into ${props.stack.base} using ${method}. ${props.hostLabel} checks their rules before merging or queueing them and rebases the remaining stack after merging.\n${layers.map((layer) => `#${layer.number} ${layer.title || layer.headBranch}`).join("\n")}`
        : `Rebase ${layers.length} ${plural(layers.length)}?\nRebase the remote branches from bottom to top onto ${props.stack.base}. This rewrites branch history and may restart checks. If a layer fails, earlier updates remain.\n${layers.map((layer) => `#${layer.number} ${layer.title || layer.headBranch}`).join("\n")}`,
    );
    if (!ok) return;
    // The run shows as a loading toast that becomes its outcome (PullRequestStackMenu run).
    const toastId = showToast({ type: "loading", title: action === "merge" ? "Merging stack..." : "Rebasing stack..." });
    const done = await props.actions.runStackAction((ref) => stackActionPayload(ref, props.stack, plan(), action, method), action === "merge" ? "Stack merge request completed" : "Stack rebased", action === "merge" ? MERGE_HINT : REBASE_HINT);
    if (!done) updateToast(toastId, { type: "error", title: action === "merge" ? "Could not merge the stack" : "Could not rebase the stack", description: props.actions.error() || (action === "merge" ? MERGE_HINT : REBASE_HINT) });
    else updateToast(toastId, { type: "success", title: action === "merge" ? "Stack merge request completed" : "Stack rebased", ...(action === "merge" ? { description: `${props.hostLabel} merged the stack or added it to its merge queue.` } : {}) });
  }

  const layers = () => [...props.stack.layers].reverse();
  return (
    <View class="flex-row items-center gap-1">
      <View
        ref={anchor.ref}
        role="button"
        tooltip={`View stack #${props.stack.number}, layer ${plan().position} of ${props.stack.layers.length}${props.notice?.() ? ` · ${props.notice()}` : ""}`}
        accessibilityLabel={`Stack ${props.stack.number}, layer ${plan().position} of ${props.stack.layers.length}`}
        accessibilityState={{ expanded: open() }}
        onPress={() => open.set(!open())}
        class="h-6 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent-50"
      >
        <PRIcon name="layers" size={14} />
        <Text class="text-xs text-foreground">{`${plan().position}/${props.stack.layers.length}`}</Text>
        {props.onRetry ? <PRIcon name="triangle-alert" size={12} /> : null}
      </View>
      {open() ? (
        <Popup anchor={anchor.anchor} onClose={() => open.set(false)} placement="bottom" align="start" class="w-80">
          <View class="flex-col p-1">
            <View class="flex-row items-center justify-between gap-2 px-2 py-1.5">
              <Text class="text-xs font-medium text-muted-foreground">{`Stack #${props.stack.number}`}</Text>
              {props.notice?.() ? <Text class="text-xs text-muted-foreground">{props.stale?.() ? "May be stale" : "Refreshing…"}</Text> : null}
            </View>
            {props.onRetry && props.stale?.() !== false ? <View role="button" accessibilityLabel="Retry stack refresh" onPress={props.onRetry} class="h-8 flex-row items-center rounded-sm px-2 hover:bg-accent-50"><Text class="text-sm text-foreground">Retry stack refresh</Text></View> : null}
            <View class="max-h-80 flex-col">
              <Each of={layers()} key={(layer: StackLayer) => layer.number}>
                {(layer) => (
                  <View
                    role="button"
                    accessibilityLabel={`Stack layer #${layer().number}`}
                    accessibilityState={{ selected: layer().number === props.currentNumber, disabled: props.actions.pending() !== null }}
                    onPress={() => { open.set(false); if (layer().number !== props.currentNumber) props.onSelect(layer()); }}
                    class="min-h-9 flex-row items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent-50"
                  >
                    <PullRequestStackLayerContent layer={layer()} scheme={props.scheme} />
                    {layer().number === props.currentNumber ? <PRIcon name="check" size={14} /> : null}
                  </View>
                )}
              </Each>
              <Text class="px-2 py-1.5 text-xs font-medium text-muted-foreground">{`↳ ${props.stack.base}`}</Text>
            </View>
            {props.canMerge() || props.canRebase() ? (
              <View class="mt-1 flex-col border-t border-border-60 pt-1">
                {props.canMerge() ? (
                  <View role="button" accessibilityLabel={`Merge stack (${plan().mergeLayers.length})`} accessibilityState={{ disabled: plan().mergeDisabled }} onPress={() => { if (!plan().mergeDisabled) void act("merge"); }} class={plan().mergeDisabled ? "h-8 flex-row items-center gap-2 rounded-sm px-2 opacity-50" : "h-8 flex-row items-center gap-2 rounded-sm px-2 hover:bg-accent-50"}>
                    <PRIcon name="git-merge" size={14} /><Text class="text-sm text-foreground">{`Merge stack (${plan().mergeLayers.length})`}</Text>
                  </View>
                ) : null}
                {props.canRebase() ? (
                  <View role="button" accessibilityLabel="Rebase stack" accessibilityState={{ disabled: plan().rebaseDisabled }} onPress={() => { if (!plan().rebaseDisabled) void act("update-branch"); }} class={plan().rebaseDisabled ? "h-8 flex-row items-center gap-2 rounded-sm px-2 opacity-50" : "h-8 flex-row items-center gap-2 rounded-sm px-2 hover:bg-accent-50"}>
                    <PRIcon name="refresh-cw" size={14} /><Text class="text-sm text-foreground">Rebase stack</Text>
                  </View>
                ) : null}
                {plan().mergeBlockedByLayer ? <Text class="px-2 py-1 text-xs text-muted-foreground">Every layer being merged must be open and ready for review.</Text> : null}
              </View>
            ) : null}
          </View>
        </Popup>
      ) : null}
    </View>
  );
}

