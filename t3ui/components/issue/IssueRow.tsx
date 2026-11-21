// Single issue list row (IssueRow.tsx): state glyph, displayKey, title, assignees/comments, author, scope, labels, relative time.
import { Text, View } from "nsh";
import { settingValue } from "../../store";
import { PRIcon } from "../pullRequest/PRIcon";
import { PullRequestActorAvatar } from "../pullRequest/PullRequestActorLabel";
import { relativeTime, toneColor, type Scheme } from "../pullRequest/pullRequestPresentation";
import {
  issueStatePresentation,
  issueTrackerPresentation,
  pullRequestLabelColor,
  type EnvironmentIssueEntry,
} from "./issueLogic";

export type IssueRowTarget = Pick<
  EnvironmentIssueEntry,
  "environmentId" | "projectId" | "tracker" | "host" | "scope" | "key" | "url"
>;

function scheme(): Scheme {
  return settingValue("colorScheme") === "light" ? "light" : "dark";
}

function LabelChip(props: { name: string; color: string | null; extra?: number }) {
  const color = props.color ? pullRequestLabelColor(props.color) : null;
  return (
    <View
      class={color ? "min-w-0 max-w-40 shrink flex-row items-center gap-1 rounded-full border px-1.5" : "min-w-0 max-w-40 shrink flex-row items-center gap-1 rounded-full bg-secondary px-1.5"}
      style={color ? { borderColor: `${color}66`, backgroundColor: `${color}1f` } : undefined}
    >
      <Text class="shrink truncate text-2xs text-foreground">{props.name}</Text>
      {props.extra ? <Text class="shrink-0 text-2xs text-muted-foreground">{`+${props.extra}`}</Text> : null}
    </View>
  );
}

export function IssueRow(props: {
  entry: EnvironmentIssueEntry;
  selected: () => boolean;
  now: () => number;
  showScope: boolean;
  showTracker: boolean;
  environmentLabel?: string | undefined;
  onSelect: (entry: IssueRowTarget) => void;
}) {
  const entry = props.entry;
  const state = issueStatePresentation(entry.state);
  const tracker = issueTrackerPresentation(entry.tracker);
  const labels = entry.labels.slice(0, 3);
  return (
    <View
      role="button"
      focusable
      accessibilityLabel={`Open issue ${entry.displayKey}: ${entry.title}`}
      accessibilityState={{ selected: props.selected() }}
      onPress={() => props.onSelect(entry)}
      class={props.selected() ? "flex-row items-center gap-2 rounded-md bg-accent px-3 py-2.5" : "flex-row items-center gap-2 rounded-md px-3 py-2.5 hover:bg-accent-50 transition-colors duration-150 ease-in-out"}
    >
      <View class="w-4 shrink-0 self-start pt-0.5">
        <PRIcon name={state.icon} size={16} tint={toneColor(state.tone, scheme())} />
      </View>
      <View class="min-w-0 flex-1 flex-col gap-0.5">
        <View class="min-w-0 flex-row items-center gap-1.5">
          <Text class="shrink-0 font-mono text-xs text-muted-foreground">{entry.displayKey}</Text>
          <Text class="min-w-0 shrink truncate text-sm font-medium text-foreground">{entry.title}</Text>
          <View class="flex-1" />
          {entry.assignees.length > 0 ? (
            <View class="shrink-0 flex-row items-center gap-0.5">
              {entry.assignees.slice(0, 3).map((assignee) => (
                <PullRequestActorAvatar actor={{ avatarUrl: assignee.avatarUrl ?? undefined }} size={14} />
              ))}
            </View>
          ) : null}
          {entry.commentCount > 0 ? (
            <View class="shrink-0 flex-row items-center gap-0.5">
              <PRIcon name="message-square" size={12} />
              <Text class="text-2xs text-muted-foreground">{String(entry.commentCount)}</Text>
            </View>
          ) : null}
        </View>
        <View class="min-w-0 flex-row items-center gap-1.5">
          <View class="max-w-40 min-w-0 shrink flex-row items-center gap-1">
            {entry.author?.avatarUrl ? <PullRequestActorAvatar actor={{ avatarUrl: entry.author.avatarUrl }} size={14} /> : null}
            <Text class="shrink truncate text-2xs text-muted-foreground">{entry.author?.login ?? "ghost"}</Text>
          </View>
          {props.showTracker ? (
            <View class="shrink-0 flex-row items-center gap-1" accessibilityLabel={tracker.providerName}>
              <PRIcon name={tracker.icon} size={12} />
            </View>
          ) : null}
          {props.showScope ? <Text class="shrink truncate text-2xs text-muted-foreground">{entry.scope}</Text> : null}
          {props.environmentLabel ? <Text class="shrink truncate text-2xs text-muted-foreground">{props.environmentLabel}</Text> : null}
          {labels.map((label, index) => (
            <LabelChip
              name={label.name}
              color={label.color}
              extra={index === labels.length - 1 ? entry.labels.length - labels.length : 0}
            />
          ))}
          <View class="flex-1" />
          <Text class="shrink-0 text-2xs text-muted-foreground">{relativeTime(entry.updatedAt, props.now())}</Text>
        </View>
      </View>
    </View>
  );
}
