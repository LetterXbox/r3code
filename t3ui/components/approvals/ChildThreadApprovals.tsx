// chat/ChildThreadApprovals.tsx: approvals waiting in a subagent or side chat under the open thread, answerable
// from the parent above its composer. Only children whose shell says an approval is pending get a detail
// subscription (retainThread), as the reference's childThreadApprovalsAtom does.
import { computed, effect, Scroll, signal, Text, View } from "nsh";
import { Menu, MenuItem } from "nsh/base";
import { allThreads, openThread, respondToApproval, retainThread, threadApprovalsFor, withThreadScope, type ApprovalDecision, type PendingApproval } from "../../store";
import { childThreadInputs } from "../banners/childInputs";
import { chatWidthClass } from "../thread/layout";
import { splitApprovalOptions } from "../thread/ApprovalPanel";
import { TimelineIcon } from "../thread/markdown/TimelineIcon";
import { trackOpenChange, useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { fullAccessOverrideExplanation } from "./approvalLogic";

export interface ChildApprovalEntry { threadId: string; title: string; approval: PendingApproval }

/** The approvals of the open thread's waiting children, in subtree order. */
export function childApprovalEntries(children: readonly { id: string; title: string; hasPendingApprovals: boolean }[], approvalsOf: (threadId: string) => PendingApproval[]): ChildApprovalEntry[] {
  return children.flatMap((child) => child.hasPendingApprovals ? approvalsOf(child.id).map((approval) => ({ threadId: child.id, title: child.title, approval })) : []);
}

const responding = signal<Record<string, boolean>>({});
const errors = signal<Record<string, string>>({});

export function ChildApprovalCard(props: { entry: () => ChildApprovalEntry; onRespond: (threadId: string, requestId: string, decision: ApprovalDecision) => Promise<void> }) {
  const key = () => `${props.entry().threadId}\0${props.entry().approval.id}`;
  const approval = () => props.entry().approval;
  const live = () => approval().responseCapability !== "not_resumable";
  const busy = () => Boolean(responding()[key()]);
  const moreOpen = signal(false);
  useOverlayOpen(moreOpen, "child approval options");
  const groups = () => splitApprovalOptions(approval().options);
  async function respond(decision: ApprovalDecision) {
    const stateKey = key();
    if (!live() || responding()[stateKey]) return;
    responding.update((all) => ({ ...all, [stateKey]: true }));
    errors.update((all) => ({ ...all, [stateKey]: "" }));
    try {
      await props.onRespond(props.entry().threadId, approval().id, decision);
    } catch (error) {
      errors.update((all) => ({ ...all, [stateKey]: error instanceof Error && error.message ? error.message : "Failed to submit approval decision." }));
    } finally {
      responding.update((all) => ({ ...all, [stateKey]: false }));
    }
  }
  return (
    <View class="rounded-lg border border-border bg-background p-3" role="group" accessibilityLabel={`Approval from ${props.entry().title}`}>
      <Text class="mb-2 text-xs font-medium text-foreground">{`Approval needed from ${props.entry().title}`}</Text>
      <Scroll class="max-h-40">
        <View selectable><Text class="font-mono text-xs text-foreground">{approval().detail || approval().kind}</Text></View>
      </Scroll>
      {approval().appName ? <Text class="mt-2 text-xs text-muted-foreground">{approval().appName}</Text> : null}
      {!live() ? <Text class="mt-2 text-xs text-warning-foreground">Provider process is gone. Interrupt or restart the child thread to respond.</Text> : null}
      {approval().reason ? <View class="mt-2" selectable><Text class="text-xs text-muted-foreground">{approval().reason}</Text></View> : null}
      {approval().fullAccessOverride ? <Text class="mt-2 text-xs text-muted-foreground">{fullAccessOverrideExplanation(approval().fullAccessOverride!)}</Text> : null}
      <View class="mt-2 flex-row flex-wrap items-center gap-2">
        <Each of={groups().primary} key={(option) => option.decision}>
          {(option) => (
            <View class="flex-row items-center gap-1 rounded px-1 hover:bg-accent" role="button" accessibilityLabel={option().label} tooltip={option().warning}
              disabled={busy() || !live()} onPress={() => void respond(option().decision)}>
              {option().warning ? <TimelineIcon name="circle-alert" size={12} /> : null}
              <Text class={option().decision === "accept" ? "text-xs font-medium text-foreground" : "text-xs font-medium text-muted-foreground"}>{option().label}</Text>
            </View>
          )}
        </Each>
        {groups().more.length > 0 ? (
          <Menu onOpenChange={trackOpenChange(moreOpen)} popupClass="min-w-[200px] rounded-lg border border-border bg-popover-84 p-1" placement="top" align="end"
            trigger={<View class="rounded px-1 hover:bg-accent" role="button" accessibilityLabel="More approval options" disabled={busy() || !live()}><Text class="text-xs font-medium text-muted-foreground">More</Text></View>}>
            <Each of={groups().more} key={(option) => option.decision}>
              {(option) => (
                <MenuItem accessibilityLabel={option().label} class="min-h-7 flex-row items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent" disabled={busy() || !live()} onSelect={() => void respond(option().decision)}>
                  {option().warning ? <TimelineIcon name="circle-alert" size={12} /> : null}
                  <Text class="min-w-0 flex-1 text-sm text-popover-foreground">{option().label}</Text>
                </MenuItem>
              )}
            </Each>
          </Menu>
        ) : null}
      </View>
      {errors()[key()] ? <Text class="mt-2 text-xs text-destructive" accessibilityLabel="Approval error">{errors()[key()]}</Text> : null}
    </View>
  );
}

/** Mounted above the main composer for the open thread. */
export function ChildThreadApprovals() {
  const children = computed(() => {
    const thread = openThread();
    return thread ? childThreadInputs(allThreads(), thread.id).filter((child) => child.hasPendingApprovals) : [];
  });
  const childIds = computed(() => children().map((child) => child.id).join("\n"));
  effect(() => {
    const ids = childIds().split("\n").filter(Boolean);
    const releases = ids.map((id) => retainThread(id));
    return () => releases.forEach((release) => release());
  });
  const entries = () => childApprovalEntries(children(), threadApprovalsFor);
  const respond = (threadId: string, requestId: string, decision: ApprovalDecision) => withThreadScope(threadId, () => respondToApproval(requestId, decision));
  return (
    <View class={`mx-auto w-full px-6 ${chatWidthClass()}`}>
      {entries().length > 0 ? (
        <Scroll class="mb-2 max-h-80">
          <View class="gap-2">
            <Each of={entries()} key={(entry) => JSON.stringify([entry.threadId, entry.approval.id])}>
              {(entry) => <ChildApprovalCard entry={entry} onRespond={respond} />}
            </Each>
          </View>
        </Scroll>
      ) : null}
    </View>
  );
}
