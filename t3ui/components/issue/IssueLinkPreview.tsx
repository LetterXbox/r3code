// Compact hover / inline preview body for an issue link (IssueLinkPreview.tsx).
import { effect, Text, untracked, View } from "nsh";
import { settingValue } from "../../store";
import { PRIcon } from "../pullRequest/PRIcon";
import { PullRequestActorLabel } from "../pullRequest/PullRequestActorLabel";
import { relativeTime, toneColor, type Scheme } from "../pullRequest/pullRequestPresentation";
import { issueStatePresentation, type IssueRef } from "./issueLogic";
import { cachedIssueDetail, loadIssueDetail, type RequestFn } from "./issueStore";

function scheme(): Scheme {
  return settingValue("colorScheme") === "light" ? "light" : "dark";
}

export function IssueLinkPreview(props: {
  environmentId: string;
  reference: IssueRef & { host: string };
  originalUrl: string;
  now?: () => number;
  request?: RequestFn;
}) {
  effect(() => {
    untracked(() => { void loadIssueDetail(props.environmentId, props.reference, { request: props.request }); });
  });
  const detail = () => cachedIssueDetail(props.environmentId, props.reference).detail;
  const d = detail();
  if (!d) {
    return <Text class="text-xs text-muted-foreground">{props.originalUrl}</Text>;
  }
  const state = issueStatePresentation(d.state);
  return (
    <View class="min-w-0 flex-col gap-1.5">
      <View class="min-w-0 flex-row items-center gap-1.5">
        <Text class="min-w-0 truncate text-2xs text-muted-foreground">{d.scope}</Text>
        <Text class="shrink-0 font-mono text-2xs text-muted-foreground">{d.displayKey}</Text>
        <Text class="text-2xs text-muted-foreground">·</Text>
        <PRIcon name={state.icon} size={12} tint={toneColor(state.tone, scheme())} />
        <Text class="text-2xs text-muted-foreground">{state.label}</Text>
      </View>
      <Text class="text-sm font-medium text-foreground">{d.title}</Text>
      <View class="flex-row items-center gap-1.5">
        <PullRequestActorLabel actor={d.author ? { login: d.author.login, avatarUrl: d.author.avatarUrl ?? undefined } : null} />
        <Text class="text-2xs text-muted-foreground">{relativeTime(d.createdAt, props.now?.() ?? Date.now())}</Text>
      </View>
    </View>
  );
}
