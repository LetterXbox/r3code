import { Scroll, signal, Text, View } from "nsh";
import { createAnchor, Popup } from "../composer/Popover";
import { PRIcon } from "./PRIcon";
import { groupChecks } from "./pullRequestActions.logic";
import { CHECK_STATUS, checkStatusLabel, type DetailCheck } from "./pullRequestDetail.logic";
import { PullRequestChecksStatusLine } from "./PullRequestDetailLayout";
import { toneColor, type Scheme } from "./pullRequestPresentation";

export function PullRequestDetailChecks(props: {
  icon: string; label: string; summary: string; tint: string; checks: () => DetailCheck[];
  stale: () => boolean; scheme: () => Scheme; onOpenCheck: (url: string) => void;
}) {
  const open = signal(false);
  const showAll = signal(false);
  const anchor = createAnchor();
  const groups = () => groupChecks(props.checks());
  const canCollapse = () => groups().attention.length + groups().running.length > 0 && groups().completed.length > 0;
  const visible = () => [...groups().attention, ...groups().running, ...(showAll() || !canCollapse() ? groups().completed : [])];
  const statusTint = (status: string) => status === "success" ? toneColor({ light: "#059669", dark: "#6ee7b7" }, props.scheme()) : status === "failure" || status === "cancelled" ? toneColor({ light: "#dc2626", dark: "#f87171" }, props.scheme()) : status === "pending" || status === "action-required" ? toneColor({ light: "#d97706", dark: "#fbbf24" }, props.scheme()) : undefined;
  return (
    <View class="ml-auto min-w-0 flex-1 flex-row items-center justify-end">
      <View ref={anchor.ref} role="button" accessibilityLabel={`Checks: ${props.label}`} onPress={() => open.set(!open())} class="shrink-0 items-center justify-center">
        <PRIcon name={props.icon} size={14} tint={props.tint} />
      </View>
      <PullRequestChecksStatusLine icon={null} label={props.summary} />
      {open() ? <Popup anchor={anchor.anchor} onClose={() => open.set(false)} placement="bottom" align="start" class="w-80">
        <View class="flex-col gap-2 p-3" accessibilityLabel="Check details">
          <Text class="text-sm font-medium text-foreground">{props.label}</Text>
          {props.stale() ? <Text class="text-xs text-muted-foreground">Check details are out of date. Refresh the pull request to update them.</Text> : <>
            {props.summary !== props.label ? <Text class="text-xs text-muted-foreground">{props.summary}</Text> : null}
            <Scroll class="max-h-64" contentClass="gap-1"><Each of={visible()} key={(check: DetailCheck, index: number) => `${index}:${check.name}`}>
              {(check) => <View class="flex-row items-center gap-2 py-0.5">
                <PRIcon name={(CHECK_STATUS[check().status] ?? { icon: "circle-dashed" }).icon} size={14} tint={statusTint(check().status)} />
                <Text class="min-w-0 flex-1 truncate text-xs text-foreground">{check().name}</Text>
                <Text class="text-xs text-muted-foreground">{checkStatusLabel(check())}</Text>
                {check().url ? <View role="button" accessibilityLabel={`Details for ${check().name}`} onPress={() => props.onOpenCheck(check().url)}><Text class="text-xs text-primary">Details</Text></View> : null}
              </View>}
            </Each></Scroll>
            {canCollapse() ? <View role="button" accessibilityLabel={showAll() ? "Show less" : "Show all"} onPress={() => showAll.set(!showAll())} class="h-6 items-center justify-center rounded-md hover:bg-accent-50"><Text class="text-xs text-muted-foreground">{showAll() ? "Show less" : "Show all"}</Text></View> : null}
          </>}
        </View>
      </Popup> : null}
    </View>
  );
}
