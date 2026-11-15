// Reaction presentation and the optimistic overlay, ported from packages/client-runtime pullRequestReactions.ts.
// The glyphs are the reference's own (client-runtime pullRequestReactions.ts REACTION_EMOJI), drawn through the emoji font.
import type { ReviewReaction } from "./pullRequestReview.logic";

export const PULL_REQUEST_REACTION_ORDER = ["thumbs-up", "thumbs-down", "laugh", "hooray", "confused", "heart", "rocket", "eyes"] as const;
export type ReactionContent = (typeof PULL_REQUEST_REACTION_ORDER)[number];

const EMOJI: Record<string, string> = {
  "thumbs-up": "👍", "thumbs-down": "👎", laugh: "😄", hooray: "🎉",
  confused: "😕", heart: "❤️", rocket: "🚀", eyes: "👀",
};
const NAME: Record<string, string> = {
  "thumbs-up": "thumbs up", "thumbs-down": "thumbs down", laugh: "laugh", hooray: "hooray", confused: "confused", heart: "heart", rocket: "rocket", eyes: "eyes",
};

export const pullRequestReactionEmoji = (content: string) => EMOJI[content] ?? "";
export const pullRequestReactionName = (content: string) => NAME[content] ?? content;

const NAMED_ACTOR_LIMIT = 3;

function joinNames(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** Hosts omit the viewer from actors; add You only if count has room, since the viewer login is unavailable. */
export function pullRequestReactionTooltip(reaction: ReviewReaction): string {
  const viewerHasRoom = reaction.actors.length < reaction.count;
  const names = reaction.viewerHasReacted && viewerHasRoom ? ["You", ...reaction.actors] : [...reaction.actors];
  const shown = names.slice(0, Math.min(NAMED_ACTOR_LIMIT, reaction.count));
  const others = Math.max(0, reaction.count - shown.length);
  const remainder = shown.length > 0 ? `${others} ${others === 1 ? "other" : "others"}` : `${others} ${others === 1 ? "person" : "people"}`;
  return `${joinNames([...shown, ...(others > 0 ? [remainder] : [])])} reacted with ${pullRequestReactionName(reaction.content)} emoji`;
}

/** Changes whenever the host reports different reactions, so pending overlays can reset. */
export function pullRequestReactionsSignature(reactions: readonly ReviewReaction[]): string {
  return reactions.map((reaction) => `${reaction.content}:${reaction.count}:${reaction.viewerHasReacted ? 1 : 0}`).join(" ");
}

export function applyPendingPullRequestReactions(reactions: readonly ReviewReaction[], pending: ReadonlyMap<string, boolean>): readonly ReviewReaction[] {
  if (pending.size === 0) return reactions;
  const byContent = new Map(reactions.map((reaction) => [reaction.content, reaction] as const));
  for (const [content, reacted] of pending) {
    const current = byContent.get(content);
    if (current === undefined) {
      if (reacted) byContent.set(content, { content, count: 1, actors: [], viewerHasReacted: true });
      continue;
    }
    if (current.viewerHasReacted === reacted) continue;
    const count = current.count + (reacted ? 1 : -1);
    if (count <= 0) byContent.delete(content);
    else byContent.set(content, { ...current, count, viewerHasReacted: reacted });
  }
  return PULL_REQUEST_REACTION_ORDER.flatMap((content) => byContent.get(content) ?? []);
}
