// The Code tab's "diff unavailable" state, ported from PullRequestDiffUnavailableState.tsx: the failure in
// plain words, Try again, Open on the host, and the raw error behind "Technical details".
import { signal, Text, View } from "nsh";
import { PRIcon } from "./PRIcon";
import { describeDiffError } from "./pullRequestDiff.logic";

export function PullRequestDiffUnavailableState(props: {
  error: string;
  providerName: string;
  /** The host's word for a change request, as in "pull request". */
  term: string;
  onRetry: () => void;
  onOpenHost: () => void;
}) {
  const details = signal(false);
  const failure = () => describeDiffError(props.error, props.providerName, props.term);
  return (
    <View class="min-h-full flex-1 flex-col items-center justify-center gap-3 px-6 py-10" accessibilityLabel="Diff unavailable">
      <View class="size-11 items-center justify-center rounded-full bg-warning-surface"><PRIcon name="triangle-alert" size={20} /></View>
      <Text class="text-center text-sm font-semibold text-foreground">{failure().title}</Text>
      <Text class="max-w-md text-center text-sm text-muted-foreground">{failure().description}</Text>
      <View class="flex-row flex-wrap justify-center gap-2">
        <View accessibilityLabel="Try again" role="button" onPress={props.onRetry} class="h-8 flex-row items-center gap-1.5 rounded-md bg-primary px-3 active:scale-[0.97] transition-transform duration-150 ease-in-out"><PRIcon name="refresh-cw" size={14} /><Text class="text-sm font-medium text-primary-foreground">Try again</Text></View>
        <View accessibilityLabel="Open on host" role="button" onPress={props.onOpenHost} class="h-8 flex-row items-center gap-1.5 rounded-md border border-border px-3 hover:bg-accent-50"><PRIcon name="external-link" size={14} /><Text class="text-sm text-foreground">{`Open on ${props.providerName}`}</Text></View>
      </View>
      <View role="button" accessibilityLabel="Technical details" accessibilityState={{ expanded: details() }} onPress={() => details.set(!details())}>
        <Text class="text-xs text-muted-foreground hover:text-foreground">Technical details</Text>
      </View>
      {details() ? (
        <View class="w-full max-w-lg rounded-lg border border-border bg-muted-40 p-3"><Text class="font-mono text-xs text-muted-foreground">{props.error}</Text></View>
      ) : null}
    </View>
  );
}

