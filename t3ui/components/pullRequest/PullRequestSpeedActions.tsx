// The quick-action group at the end of a list row (PullRequestSpeedActions.tsx). It shows while Shift is held
// over the list, or while an action runs.
import { signal, Text, View } from "nsh";
import type { ViewRef } from "nsh";
import { showToast } from "../toast";
import { settingValue } from "../../store";
import { PRIcon } from "./PRIcon";
import { closingRows, endCloseSweep, startCloseSweep, sweptRows } from "./pullRequestCloseSweep";
import { pullRequestQuickActions, type PullRequestQuickAction } from "./pullRequestList.logic";
import { quickActionDone, QUICK_ACTION_LABEL, runQuickAction, speedMode } from "./pullRequestSpeed.logic";
import type { PullRequestEntry } from "../../pages/utility-data";

const ICONS = { close: "git-pull-request-closed", merge: "git-merge", ready: "git-pull-request-arrow", reopen: "git-pull-request-arrow" } as const;

export function PullRequestSpeedActions(props: {
  entry: PullRequestEntry;
  hostActions: () => ReadonlySet<string>;
  request: (method: string, payload: unknown) => Promise<unknown>;
  /** The row's action finished: the list reloads. */
  onActed?: () => void;
  /** The action that finished, for the list's override (pullRequestOverrideAfterAction). */
  onActionDone?: (entry: PullRequestEntry, action: string) => void;
  term?: string;
  /** The row's key and group: a drag that starts on Close sweeps the rows of this group (pullRequestCloseSweep). */
  sweep?: { key: string };
}) {
  const pending = signal<string | null>(null);
  const actions = () => pullRequestQuickActions(props.entry, props.hostActions());
  const term = () => props.term ?? "pull request";
  async function perform(action: "close" | "merge" | "ready" | "reopen") {
    if (pending() !== null) return;
    pending.set(action);
    try {
      // PullRequestSpeedActions.tsx resolveMergeMethod: the settings' default merge method ranks after the PR's own.
      const preferred = settingValue("pullRequestMergeMethod");
      await runQuickAction(props.request, props.entry, action, preferred === "merge" || preferred === "squash" || preferred === "rebase" ? { projectDefault: preferred } : {});
      showToast({ type: "success", title: `${quickActionDone(action)}` });
      // Some hosts accept a merge before it completes: the next read says so (onSpeedAction).
      if (action !== "merge") props.onActionDone?.(props.entry, action);
      props.onActed?.();
    } catch (cause) {
      showToast({ type: "error", title: `Could not ${QUICK_ACTION_LABEL[action].toLowerCase()} the ${term()}`, description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      pending.set(null);
    }
  }
  const sweptHere = () => props.sweep !== undefined && (sweptRows().has(props.sweep.key) || closingRows().has(props.sweep.key));
  const shown = () => actions().length > 0 && (speedMode() || pending() !== null || sweptHere());
  let pressAt: { x: number; y: number } | null = null;
  let closeNode: ViewRef | null = null;
  return (
    <View class="shrink-0 flex-row items-center">
      {shown() ? <View class="shrink-0 flex-row items-center gap-1 pr-3" accessibilityLabel={`Quick actions for ${term()} #${props.entry.number}`}>
      <Each of={actions()} key={(action: PullRequestQuickAction) => action}>
        {(action) => (
          <View
            role="button"
            tooltip={action() === "close" ? (props.sweep ? "Close immediately, or drag across rows to close several" : "Close immediately") : `${QUICK_ACTION_LABEL[action()]} immediately`}
            accessibilityLabel={`${QUICK_ACTION_LABEL[action()]} #${props.entry.number}`}
            accessibilityState={{ disabled: pending() !== null }}
            onPress={() => void perform(action())}
            {...(action() === "close" && props.sweep ? {
              ref: (node: ViewRef) => { closeNode = node; },
              onPressDown: (event: { pagePosition: { x: number; y: number } }) => { pressAt = event.pagePosition; },
              onPanStart: () => {
                if (pending() !== null) return;
                // The press point, else the button's middle (a touch drag lands there).
                if (pressAt) { void startCloseSweep(props.sweep!.key, pressAt, props.request, () => props.onActed?.(), props.onActionDone); return; }
                void closeNode?.measure().then((at) => { if (at) void startCloseSweep(props.sweep!.key, { x: at.pagePosition.x + at.bounds.size.width / 2, y: at.pagePosition.y + at.bounds.size.height / 2 }, props.request, () => props.onActed?.(), props.onActionDone); });
              },
              onPanEnd: (event: { translation: { x: number; y: number }; cancelled: boolean }) => { void endCloseSweep(event.translation.y, event.cancelled); },
            } : {})}
            class={`h-6 flex-row items-center gap-1 rounded-md border px-2 ${action() === "close" ? "border-destructive" : "border-border"} ${pending() !== null || sweptHere() ? "opacity-50" : "hover:bg-accent-50"}`}
          >
            <PRIcon name={ICONS[action()]} size={12} />
            <Text class={action() === "close" ? "text-xs text-destructive" : "text-xs text-foreground"}>{QUICK_ACTION_LABEL[action()]}</Text>
          </View>
        )}
      </Each>
    </View> : null}
    </View>
  );
}

