// A comment's rendered body, clipped at 240 pt with a "Show full comment" toggle (PullRequestCommentBody.tsx).
import { signal, Text, View } from "nsh";
import { PullRequestMarkdown } from "./PullRequestMarkdown";

export const COMMENT_CLIP_HEIGHT = 240;

export function PullRequestCommentBody(props: { text: string | (() => string); class?: string }) {
  const expanded = signal(false);
  const height = signal(0);
  const overflowing = () => height() > COMMENT_CLIP_HEIGHT;
  return (
    <View class={`min-w-0 flex-col ${props.class ?? ""}`}>
      <View class="relative" style={expanded() ? undefined : { maxHeight: COMMENT_CLIP_HEIGHT, overflow: "hidden" }}>
        <View onLayout={(event) => height.set(event.bounds.size.height)}>
          <PullRequestMarkdown text={props.text} />
        </View>
      </View>
      {overflowing() ? (
        <View
          role="button"
          accessibilityLabel={expanded() ? "Show less" : "Show full comment"}
          accessibilityState={{ expanded: expanded() }}
          onPress={() => expanded.set(!expanded())}
          class="mt-2 h-6 flex-row items-center self-start rounded-md px-2 hover:bg-accent-50"
        >
          <Text class="text-xs text-muted-foreground">{expanded() ? "Show less" : "Show full comment"}</Text>
        </View>
      ) : null}
    </View>
  );
}

