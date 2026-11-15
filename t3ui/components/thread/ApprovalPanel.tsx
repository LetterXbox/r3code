// TimelinePendingApprovalRow.tsx + ComposerPendingApprovalActions.tsx: a work-log style row with the
// request's icon and complete detail in a code block, then "Waiting for approval" with the
// decline and approve actions inline and the rest behind More.
import { ORCHESTRATION_OPERATE_SCOPE, scopeAllows } from "../../backend/sessionScopes";
import { Scroll, signal, Text, View } from "nsh";
import { Menu, MenuItem } from "nsh/base";
import { chatWidthClass } from "./layout";
import { IconSlot, TimelineIcon } from "./markdown/TimelineIcon";
import { trackOpenChange, useOverlayOpen } from "../rightPanel/nativeOcclusion";
import type { ApprovalDecision, PendingApproval } from "../../store";
import { FullAccessOverrideQuestion } from "../approvals/FullAccessOverrideQuestion";

export type ApprovalDisplay = Pick<PendingApproval, "id" | "title" | "detail" | "options"> & Partial<Pick<PendingApproval, "appName" | "fullAccessOverride" | "responseCapability">> & { kind?: string; reason?: string };

const APPROVAL_PRESENTATION: Record<string, { icon: string; label: string; detailLabel: string }> = {
  command: { icon: "terminal", label: "Command approval", detailLabel: "Command" },
  "file-change": { icon: "square-pen", label: "File change approval", detailLabel: "File change" },
  "file-read": { icon: "eye", label: "File read approval", detailLabel: "File to read" },
  permission: { icon: "wrench", label: "App permission approval", detailLabel: "Permission request" },
  "mcp-elicitation": { icon: "hammer", label: "App access approval", detailLabel: "App access request" },
};

export function approvalPresentation(kind: string | undefined) {
  return (kind ? APPROVAL_PRESENTATION[kind] : undefined) ?? { icon: "shield-check", label: "Approval requested", detailLabel: "Request" };
}

/** Decline and approve show as buttons; every other decision waits behind More. */
export function splitApprovalOptions<T extends { decision: ApprovalDecision }>(options: readonly T[]) {
  return {
    primary: options.filter((option) => option.decision === "decline" || option.decision === "accept"),
    more: options.filter((option) => option.decision !== "decline" && option.decision !== "accept"),
  };
}

const busy = signal<Record<string, boolean>>({});
const errors = signal<Record<string, string>>({});

export function ApprovalPanel(props: {
  scope: () => string;
  approvals: () => ApprovalDisplay[];
  onRespond: (id: string, decision: ApprovalDecision) => Promise<void>;
  /** Drawn inside a work group (TimelinePendingApprovalRow) rather than as the lane-wide list. */
  inline?: boolean;
}) {
  const key = (id: string) => `${props.scope()}\0${id}`;
  async function respond(id: string, decision: ApprovalDecision) {
    const stateKey = key(id);
    if (busy()[stateKey]) return;
    busy.update((current) => ({ ...current, [stateKey]: true }));
    errors.update((current) => ({ ...current, [stateKey]: "" }));
    try {
      await props.onRespond(id, decision);
    } catch (error) {
      // useThreadRequests: the failure's own message, else "Failed to submit approval decision."
      errors.update((current) => ({ ...current, [stateKey]: error instanceof Error && error.message ? error.message : "Failed to submit approval decision." }));
      busy.update((current) => ({ ...current, [stateKey]: false }));
    }
  }
  const itemClass = "min-h-7 flex-row items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent";

  return (
    <View class={props.inline ? "min-w-0" : `mx-auto w-full px-6 pb-2 ${chatWidthClass()}`}>
      <Each of={props.approvals()} key={(approval) => approval.id}>
        {(approval) => {
          const presentation = () => approvalPresentation(approval().kind);
          const groups = () => splitApprovalOptions(approval().options);
          const moreOpen = signal(false);
          useOverlayOpen(moreOpen, "approval options");
          // TimelinePendingApprovalRow: disabled while responding or when this session cannot operate the thread.
          const responding = () => Boolean(busy()[key(approval().id)]) || !scopeAllows(ORCHESTRATION_OPERATE_SCOPE);
          // TimelinePendingApprovalRow: a request the provider can no longer answer shows why instead of its actions.
          const canRespond = () => approval().responseCapability !== "not_resumable";
          return (
            <View class="mb-2 min-w-0 rounded-md px-0.5 py-0.5" role="group" accessibilityLabel={presentation().label}>
              <View class="min-h-6 flex-row items-start gap-1.5">
                <View class="size-6 items-center justify-center">
                  <IconSlot name={presentation().icon} size={16} />
                </View>
                <Scroll class="max-h-40 min-w-0 flex-1">
                  <View class="min-w-0" selectable accessibilityLabel={presentation().detailLabel}>
                    <Text class="font-mono text-xs leading-5 text-foreground">{approval().detail || presentation().label}</Text>
                  </View>
                </Scroll>
              </View>
              <View class="ms-7.5 min-w-0 gap-1 pb-1">
                {approval().appName ? <Text class="text-xs text-muted-foreground">{approval().appName}</Text> : null}
                {approval().reason ? <View selectable><Text class="text-xs text-muted-foreground">{approval().reason}</Text></View> : null}
                {errors()[key(approval().id)] ? <Text class="text-xs text-destructive">{errors()[key(approval().id)]}</Text> : null}
                <View class="flex-row flex-wrap items-center gap-x-2 gap-y-1">
                  {!canRespond() ? <Text class="text-xs text-warning-foreground">Provider process is gone. Interrupt or restart the run to respond.</Text> : null}
                  {canRespond() ? <View class="flex-row items-center gap-1">
                    <TimelineIcon name="shield" size={12} />
                    <Text class="text-xs text-warning-foreground">Waiting for approval</Text>
                  </View> : null}
                  {canRespond() ? <Text class="text-xs text-muted-foreground">·</Text> : null}
                  <Each of={canRespond() ? groups().primary : []} key={(option) => option.decision}>
                    {(option) => (
                      <View
                        class="flex-row items-center gap-1 rounded px-1 hover:bg-accent"
                        onPress={() => void respond(approval().id, option().decision)}
                        disabled={responding()}
                        tooltip={option().warning}
                        accessibilityLabel={option().label}
                        role="button"
                      >
                        {option().warning ? <TimelineIcon name="circle-alert" size={12} /> : null}
                        <Text class={option().decision === "accept" ? "text-xs font-medium text-foreground" : "text-xs font-medium text-muted-foreground"}>{option().label}</Text>
                      </View>
                    )}
                  </Each>
                  {canRespond() && groups().more.length > 0 ? (
                    <Menu
                      onOpenChange={trackOpenChange(moreOpen)}
                      popupClass="min-w-[200px] rounded-lg border border-border bg-popover-84 p-1"
                      placement="top"
                      align="end"
                      trigger={
                        <View class="rounded px-1 hover:bg-accent" accessibilityLabel="More approval options" disabled={responding()} role="button">
                          <Text class="text-xs font-medium text-muted-foreground">More</Text>
                        </View>
                      }
                    >
                      <Each of={groups().more} key={(option) => option.decision}>
                        {(option) => (
                          <MenuItem accessibilityLabel={option().label} class={itemClass} disabled={responding()} onSelect={() => void respond(approval().id, option().decision)}>
                            {option().warning ? <TimelineIcon name="circle-alert" size={12} /> : null}
                            <Text class="min-w-0 flex-1 text-sm text-popover-foreground">{option().label}</Text>
                          </MenuItem>
                        )}
                      </Each>
                    </Menu>
                  ) : null}
                  {approval().fullAccessOverride ? (
                    <FullAccessOverrideQuestion override={() => approval().fullAccessOverride ?? ""} />
                  ) : null}
                </View>
              </View>
            </View>
          );
        }}
      </Each>
    </View>
  );
}
