// What the Timeline and Summary tabs show when the activity could not be read (PullRequestActivityUnavailableState.tsx).
import { Text, View } from "nsh";
import { PRIcon } from "./PRIcon";

export function PullRequestActivityUnavailableState(props: {
  error: string;
  /** The host's word for a change request, as in "pull request". */
  term: string;
  onRetry: () => void;
  compact?: boolean;
}) {
  return (
    <View class={props.compact ? "flex-col items-center justify-center gap-2 py-3" : "min-h-48 flex-col items-center justify-center gap-2 px-4 py-10"} accessibilityLabel="Activity unavailable">
      <Text class="text-center text-sm font-medium text-foreground">{`Could not load ${props.term} activity`}</Text>
      <Text class="max-w-md text-center text-xs text-muted-foreground">{props.error}</Text>
      <View role="button" accessibilityLabel="Retry" onPress={props.onRetry} class="h-7 flex-row items-center gap-1.5 rounded-md border border-border px-2.5 hover:bg-accent-50">
        <PRIcon name="refresh-cw" size={14} />
        <Text class="text-sm text-foreground">Retry</Text>
      </View>
    </View>
  );
}

