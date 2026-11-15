// The checks list that opens under a row's checks icon, ported from PullRequestChecksPopover.tsx:
// failing and running checks first, finished ones behind "Show all", a Details link per check.
import { Text, View } from "nsh";
import { PRIcon } from "./PRIcon";
import { checksShowAll, checksView, toggleChecksShowAll } from "./pullRequestChecksStore";
import { describeChecks, groupChecks } from "./pullRequestActions.logic";
import { CHECK_STATUS, type DetailCheck, checkStatusLabel } from "./pullRequestDetail.logic";
import { toneColor, type Scheme } from "./pullRequestPresentation";

function tint(status: string, scheme: Scheme): string | undefined {
  if (status === "success") return toneColor({ light: "#059669", dark: "#6ee7b7" }, scheme);
  if (status === "failure" || status === "cancelled") return toneColor({ light: "#dc2626", dark: "#f87171" }, scheme);
  if (status === "pending" || status === "action-required") return toneColor({ light: "#d97706", dark: "#fbbf24" }, scheme);
  return undefined;
}

export function PullRequestChecksPopover(props: { entryKey: string; scheme: () => Scheme; onOpenLink: (url: string) => void }) {
  const view = () => checksView(props.entryKey);
  const groups = () => groupChecks(view()?.checks ?? []);
  const canCollapse = () => groups().attention.length + groups().running.length > 0 && groups().completed.length > 0;
  const visible = (): DetailCheck[] => [...groups().attention, ...groups().running, ...(checksShowAll(props.entryKey) || !canCollapse() ? groups().completed : [])];
  return (
    <View class="mb-1 ml-9 mr-3 flex-col gap-1 rounded-lg border border-border bg-popover p-3" accessibilityLabel="Checks">
      {view()?.status === "loading" ? <Text class="text-xs text-muted-foreground">Loading checks…</Text> : null}
      {view()?.status === "error" ? <Text class="text-xs text-destructive">{view()!.error}</Text> : null}
      {view()?.status === "loaded" ? <Text class="text-xs font-medium text-foreground">{describeChecks(view()!.checks)}</Text> : null}
      {view()?.status === "loaded" && view()!.checks.length === 0 ? <Text class="text-xs text-muted-foreground">No checks reported</Text> : null}
      <Each of={visible()} key={(check: DetailCheck, index: number) => `${index}:${check.name}`}>
        {(check) => {
          const status = CHECK_STATUS[check().status] ?? { label: check().status, icon: "circle-dashed" };
          return (
            <View class="flex-row items-center gap-2 py-0.5">
              <PRIcon name={status.icon} size={14} tint={tint(check().status, props.scheme())} />
              <Text class="min-w-0 flex-1 truncate text-xs text-foreground">{check().name}</Text>
              <Text class="text-xs text-muted-foreground">{checkStatusLabel(check())}</Text>
              {check().url ? (
                <View accessibilityLabel={`Details for ${check().name}`} role="button" onPress={() => props.onOpenLink(check().url)}><Text class="text-xs text-primary">Details</Text></View>
              ) : null}
            </View>
          );
        }}
      </Each>
      {canCollapse() ? (
        <View accessibilityLabel={checksShowAll(props.entryKey) ? "Show less" : "Show all"} role="button" onPress={() => toggleChecksShowAll(props.entryKey)} class="h-6 items-center justify-center rounded-md hover:bg-accent-50">
          <Text class="text-xs text-muted-foreground">{checksShowAll(props.entryKey) ? "Show less" : "Show all"}</Text>
        </View>
      ) : null}
    </View>
  );
}

