// "N more replies" under a thread whose later comments the host did not return (PullRequestMoreReplies.tsx).
import { openUrl, Text, View } from "nsh";

export interface PullRequestReplyAvailability {
  moreReplies: number;
  hasMoreReplies: boolean;
  url: string | null;
}

export function moreRepliesLabel(moreReplies: number): string {
  return moreReplies > 0 ? `${moreReplies.toLocaleString("en-US")} more ${moreReplies === 1 ? "reply" : "replies"}` : "More replies";
}

export function PullRequestMoreReplies(props: PullRequestReplyAvailability) {
  if (!props.hasMoreReplies) return null;
  return (
    <View class="flex-row flex-wrap items-baseline gap-2 py-1">
      <Text class="text-xs text-muted-foreground">{moreRepliesLabel(props.moreReplies)}</Text>
      {props.url ? (
        <View role="link" accessibilityLabel="View on host" onPress={() => void openUrl(props.url as string)}>
          <Text class="text-xs text-muted-foreground hover:text-foreground">View on host</Text>
        </View>
      ) : null}
    </View>
  );
}

