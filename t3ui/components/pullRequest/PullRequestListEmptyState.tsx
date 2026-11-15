// The illustrated empty states, ported from PullRequestListEmptyState.tsx and
// PullRequestsUnavailableState.tsx.
import { Text, View } from "nsh";
import { BranchMark, PRIcon } from "./PRIcon";
import type { emptyStateKind } from "./pullRequestList.logic";

function Button(props: { label: string; icon?: string; disabled?: boolean; onPress: () => void; busy?: boolean }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      onPress={() => { if (!props.disabled) props.onPress(); }}
      class={props.disabled ? "h-8 flex-row items-center gap-1.5 rounded-md border border-border px-3 opacity-50" : "h-8 flex-row items-center gap-1.5 rounded-md border border-border px-3 hover:bg-accent-50"}
    >
      {props.icon ? <PRIcon name={props.icon} size={14} /> : null}
      <Text class="text-sm text-foreground">{props.label}</Text>
    </View>
  );
}

function Empty(props: { title: string; description: string; children?: unknown }) {
  return (
    <View class="min-w-0 flex-1 flex-col items-center justify-center gap-6 p-12">
      <BranchMark />
      <View class="max-w-sm flex-col items-center gap-1">
        <Text class="text-center text-lg font-semibold text-foreground">{props.title}</Text>
        <Text class="text-center text-sm text-muted-foreground">{props.description}</Text>
      </View>
      {props.children as never}
    </View>
  );
}

function clip(query: string): string {
  return query.length > 48 ? `${query.slice(0, 48)}…` : query;
}

export function PullRequestListEmptyState(props: {
  kind: ReturnType<typeof emptyStateKind>;
  query: string;
  canLoadMore: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  onClearQuery: () => void;
  onLoadMore: () => void;
  onRefresh: () => void;
  onAddProject: () => void;
}) {
  if (props.kind === "no-projects") {
    return (
      <Empty title="No projects in this workspace" description="Add a project, and the pull requests from its repository appear here.">
        <Button label="Add project" icon="plus" onPress={props.onAddProject} />
      </Empty>
    );
  }
  if (props.kind === "search") {
    return (
      <Empty title={`Nothing matches “${clip(props.query)}”`} description="The hosts were searched for it. Try fewer words, or search by number, author or branch.">
        <View class="flex-row flex-wrap justify-center gap-2">
          <Button label="Clear search" icon="search" onPress={props.onClearQuery} />
          <Button label={props.refreshing ? "Checking..." : "Check again"} icon="refresh-cw" disabled={props.refreshing} onPress={props.onRefresh} />
        </View>
      </Empty>
    );
  }
  return (
    <Empty
      title={props.kind === "filtered" ? "Nothing under these filters" : "No pull requests"}
      description={props.kind === "filtered" ? "Widen the state, involvement or project filter to see more." : "Pull requests from every project in this workspace appear here."}
    >
      <View class="flex-row flex-wrap justify-center gap-2">
        {props.canLoadMore ? <Button label={props.loadingMore ? "Loading..." : "Load more pull requests"} disabled={props.loadingMore} onPress={props.onLoadMore} /> : null}
        <Button label={props.refreshing ? "Checking..." : "Check again"} icon="refresh-cw" disabled={props.refreshing} onPress={props.onRefresh} />
      </View>
    </Empty>
  );
}

export { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";

