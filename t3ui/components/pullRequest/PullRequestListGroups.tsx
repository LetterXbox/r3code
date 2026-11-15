// Group headers and rows, ported from PullRequestListGroups.tsx.
import { cleanup, Text, View, Overlay } from "nsh";
import type { PullRequestEntry } from "../../pages/utility-data";
import { PRIcon } from "./PRIcon";
import { entryKey, type PullRequestGroup, matchedElsewhere } from "./pullRequestList.logic";
import { PullRequestRow } from "./PullRequestRow";
import { moveCloseSweep, sweptRows } from "./pullRequestCloseSweep";
import { followSpeedMode, speedMode } from "./pullRequestSpeed.logic";

const GROUP_ICONS: Record<string, string> = { authored: "pen-line", reviewRequested: "eye", others: "users" };

function GroupHeader(props: { group: PullRequestGroup }) {
  return (
    <View class="flex-row items-center gap-2 px-3 pb-1">
      <PRIcon name={GROUP_ICONS[props.group.key] ?? "layers"} size={14} />
      <Text class="shrink-0 text-xs font-medium text-muted-foreground">{props.group.label}</Text>
      <Text class="shrink-0 text-xs text-muted-foreground">{String(props.group.entries.length)}</Text>
      <View class="h-px min-w-2 flex-1 bg-border" />
    </View>
  );
}

export function PullRequestListGroups(props: {
  groups: () => PullRequestGroup[];
  selectedKey: () => string | null;
  now: () => number;
  onSelect: (entry: PullRequestEntry) => void;
  request?: (method: string, payload: unknown) => Promise<unknown>;
  /** The change request actions each host takes, by host (the list result's providers). */
  hostActions?: (host: string) => ReadonlySet<string>;
  onActed?: () => void;
  /** The row the pointer rests on (null when it leaves), for the detail read-ahead. */
  onIntent?: (entry: PullRequestEntry | null) => void;
  onActionDone?: (entry: PullRequestEntry, action: string) => void;
  /** The typed query: a row it does not visibly match was found by its description. */
  query?: () => string;
}) {
  // The modifier state belongs to this list, not a future visit to the page.
  cleanup(() => speedMode.set(false));
  return (
    <View class="flex-col gap-3" onMouseMove={followSpeedMode} onMouseLeave={() => speedMode.set(false)}>
      {/* A close sweep follows the pointer across the window until it is released (pullRequestCloseSweep). */}
      {sweptRows().size > 0 ? <Overlay class="inset-0 z-50" accessibilityLabel="Closing pull requests by drag" onMouseMove={(event) => moveCloseSweep(event.pagePosition.y)} /> : null}
      <Each of={props.groups()} key={(group: PullRequestGroup) => group.key}>
        {(group) => (
          <View class="flex-col gap-0.5">
            {group().label ? <GroupHeader group={group()} /> : null}
            <Each of={group().entries} key={(entry: PullRequestEntry) => entryKey(entry)}>
              {(entry) => (
                <PullRequestRow
                  entry={entry()}
                  showProject
                  now={props.now}
                  selected={() => props.selectedKey() === entryKey(entry())}
                  onSelect={props.onSelect}
                  {...(props.request ? { request: props.request } : {})}
                  {...(props.hostActions ? { hostActions: () => props.hostActions!(entry().host) } : {})}
                  {...(props.onActed ? { onActed: props.onActed } : {})}
                  {...(props.onIntent ? { onIntent: props.onIntent } : {})}
                  matchedElsewhere={props.query ? matchedElsewhere(entry(), props.query()) : false}
                  groupKey={group().key}
                  {...(props.onActionDone ? { onActionDone: props.onActionDone } : {})}
                />
              )}
            </Each>
          </View>
        )}
      </Each>
    </View>
  );
}

