// The detail panel's header body, tab bar and checks line, ported from PullRequestDetailLayout.tsx.
import { Text, View } from "nsh";
import { PRIcon } from "./PRIcon";

/** PullRequestMetaLine: segments joined by a dot. */
export function PullRequestMetaLine(props: { children: unknown[] }) {
  const segments = props.children.filter((segment) => segment !== null && segment !== undefined && segment !== false);
  return (
    <View class="min-w-0 flex-row items-center gap-1.5">
      {segments.flatMap((segment, index) => (index === 0 ? [segment] : [<Text class="shrink-0 text-xs text-muted-foreground">·</Text>, segment])) as never}
    </View>
  );
}

export function PullRequestDetailTitleRow(props: { children: unknown }) {
  return <View class="min-h-6 min-w-0 flex-row items-center gap-1">{props.children as never}</View>;
}

/** Title, author and update time (with the checkout command), then base <- head with the changed files and the diff stat. */
export function PullRequestDetailHeaderBody(props: {
  title: unknown; author: unknown; updated: unknown; checkout?: unknown; base: unknown; head: unknown; files: unknown; diffStat: unknown;
}) {
  return (
    <View class="mt-1 min-w-0 flex-col px-4 pb-4">
      {props.title as never}
      <View class="mt-2 min-h-5 min-w-0 flex-row items-center gap-2">
        <PullRequestMetaLine>{[props.author, props.updated]}</PullRequestMetaLine>
        <View class="flex-1" />
        {props.checkout as never}
      </View>
      <View class="mt-4 min-h-5 min-w-0 flex-row items-center gap-2">
        <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
          {props.base as never}
          <View accessibilityLabel="receives changes from"><PRIcon name="arrow-left" size={14} /></View>
          {props.head as never}
        </View>
        <View class="shrink-0 flex-row items-center justify-end gap-2">
          <View class="min-w-16 flex-row items-center justify-end gap-1.5">
            <PRIcon name="file-diff" size={14} />
            <Text class="text-xs text-muted-foreground">{props.files as string}</Text>
          </View>
          {props.diffStat as never}
        </View>
      </View>
    </View>
  );
}

/** The segmented tab group and, to its right, what the tab has to say (the checks line, the timeline counts). */
export function PullRequestDetailTabBar<Tab extends string>(props: {
  tabs: readonly { value: Tab; label: string }[];
  value: Tab;
  onValueChange: (tab: Tab) => void;
  children?: unknown;
}) {
  return (
    <View class="min-w-0 flex-row flex-wrap items-center gap-2 border-t border-border-60 px-4 py-2" accessibilityLabel="Pull request tabs">
      <View class="shrink-0 flex-row items-center gap-0.5 rounded-lg bg-segmented-track p-0.5">
        <Each of={[...props.tabs]} key={(tab: { value: Tab; label: string }) => tab.value}>
          {(tab) => (
            <View
              role="button"
              accessibilityLabel={tab().label}
              accessibilityState={{ selected: props.value === tab().value }}
              onPress={() => props.onValueChange(tab().value)}
              class={props.value === tab().value ? "h-6 items-center justify-center rounded-md bg-segmented-active px-2.5 transition-colors duration-150 ease-in-out" : "h-6 items-center justify-center rounded-md px-2.5 hover:bg-segmented-hover transition-colors duration-150 ease-in-out"}
            >
              <Text class={props.value === tab().value ? "text-xs font-medium text-foreground" : "text-xs text-muted-foreground"}>{tab().label}</Text>
            </View>
          )}
        </Each>
      </View>
      {props.children as never}
    </View>
  );
}

export function PullRequestChecksStatusLine(props: { icon: unknown; label: unknown; accessibilityLabel?: string; tint?: string }) {
  return (
    <View class="ml-auto h-4 min-w-0 flex-1 flex-row flex-wrap items-center justify-end gap-1.5 overflow-hidden" accessibilityLabel={props.accessibilityLabel}>
      {props.icon as never}
      <Text class="shrink-0 text-xs text-muted-foreground" style={props.tint ? { color: props.tint } : undefined}>{props.label as string}</Text>
    </View>
  );
}

