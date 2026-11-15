// The reaction pills under a comment or the description and the picker that adds one (PullRequestReactions.tsx).
import { createAnchor, Popup } from "../composer/Popover";
import { signal, Text, View } from "nsh";
import { PRIcon } from "./PRIcon";
import {
  applyPendingPullRequestReactions, PULL_REQUEST_REACTION_ORDER, pullRequestReactionEmoji, pullRequestReactionName,
  pullRequestReactionsSignature, pullRequestReactionTooltip,
} from "./pullRequestReactions.logic";
import type { ReviewReaction } from "./pullRequestReview.logic";
import { Presence } from "../motion/Motion";
import { DURATION_DEFAULT_MS } from "../motion/motionTokens";

const PILL = "h-6 shrink-0 flex-row items-center gap-1 rounded-full border px-2 transition-colors duration-150 ease-in-out";

export function PullRequestReactionBar(props: {
  reactions: () => readonly ReviewReaction[];
  canReact: () => boolean;
  /** Sets or clears one reaction; rejects when the host refuses so the optimistic pill is undone. */
  onToggle: (content: string, reacted: boolean) => Promise<void>;
  onFailed?: (message: string) => void;
}) {
  const pickerOpen = signal(false);
  const pending = signal<{ signature: string; values: ReadonlyMap<string, boolean> }>({ signature: "", values: new Map() });
  const anchor = createAnchor();

  const signature = () => pullRequestReactionsSignature(props.reactions());
  const values = () => (pending().signature === signature() ? pending().values : new Map<string, boolean>());
  const shown = () => applyPendingPullRequestReactions(props.reactions(), values());

  async function toggle(content: string, reacted: boolean) {
    const at = signature();
    pending.set({ signature: at, values: new Map([...values(), [content, reacted]]) });
    try {
      await props.onToggle(content, reacted);
    } catch {
      const next = new Map(pending().values);
      next.delete(content);
      pending.set({ signature: pending().signature, values: next });
      props.onFailed?.("The reaction could not be saved");
    }
  }

  return (
    <View class="min-w-0 max-w-full flex-row flex-wrap items-center gap-1">
      {props.canReact() || shown().length > 0 ? (
        <>
          <Each of={shown() as ReviewReaction[]} key={(reaction: ReviewReaction) => reaction.content}>
            {(reaction) => (
              <View
                role="button"
                tooltip={pullRequestReactionTooltip(reaction())}
                accessibilityLabel={`${pullRequestReactionName(reaction().content)}, ${reaction().count}`}
                accessibilityState={{ pressed: reaction().viewerHasReacted, disabled: !props.canReact() }}
                onPress={() => { if (props.canReact()) void toggle(reaction().content, !reaction().viewerHasReacted); }}
                class={reaction().viewerHasReacted ? `${PILL} border-primary bg-accent` : `${PILL} border-border-60 bg-muted-40 ${props.canReact() ? "hover:border-primary" : ""}`}
              >
                <Text class="text-xs">{pullRequestReactionEmoji(reaction().content)}</Text>
                <Text class="text-xs text-muted-foreground">{String(reaction().count)}</Text>
              </View>
            )}
          </Each>
          {props.canReact() ? (
            <View>
              <View ref={anchor.ref} role="button" accessibilityLabel="Add a reaction" onPress={() => pickerOpen.set(!pickerOpen())} class={`${PILL} border-border-60 px-1.5 hover:border-primary`}>
                <PRIcon name="smile-plus" size={14} />
              </View>
              <Presence when={pickerOpen} ms={DURATION_DEFAULT_MS}>{(closing) => (
                <Popup animated closing={closing} anchor={anchor.anchor} onClose={() => pickerOpen.set(false)} placement="top" align="start">
                  <View class="flex-row items-center gap-0.5 p-1">
                    <Each of={[...PULL_REQUEST_REACTION_ORDER]} key={(content: string) => content}>
                      {(content) => {
                        const reacted = () => shown().find((reaction) => reaction.content === content())?.viewerHasReacted ?? false;
                        return (
                          <View
                            role="button"
                            accessibilityLabel={pullRequestReactionName(content())}
                            accessibilityState={{ pressed: reacted() }}
                            onPress={() => { pickerOpen.set(false); void toggle(content(), !reacted()); }}
                            class={reacted() ? "size-7 items-center justify-center rounded-md bg-accent" : "size-7 items-center justify-center rounded-md hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out"}
                          >
                            <Text class="text-base">{pullRequestReactionEmoji(content())}</Text>
                          </View>
                        );
                      }}
                    </Each>
                  </View>
                </Popup>
              )}</Presence>
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

