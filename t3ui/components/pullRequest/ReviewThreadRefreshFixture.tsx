import { mount, signal, Text, View } from "nsh";
import { ReviewThreadCard } from "./PullRequestReviewAnnotation";
import type { PullRequestActionsModel } from "./pullRequestActionsModel";
import type { ReviewThread } from "./pullRequestReview.logic";

const thread = signal<ReviewThread>({ id: "thread", path: "src/old.ts", line: 1, side: "right", isResolved: false, isOutdated: false, commentCount: 1, nextCommentsCursor: null, canResolve: false, comments: [{ id: "comment", author: null, body: "Before refresh", createdAt: "2026-01-01T00:00:00Z", editedAt: null, url: "", reactions: [], canEdit: false }] });
const actions = { pending: () => null } as PullRequestActionsModel;
const fix = signal(false);
mount(() => <View class="flex-1"><View role="button" accessibilityLabel="Refresh review" onPress={() => thread.update((old) => ({ ...old, path: "src/new.ts", comments: [{ ...old.comments[0]!, body: "After refresh" }] }))}><Text>Refresh</Text></View><View role="button" accessibilityLabel="Show partial thread" onPress={() => thread.update((old) => ({ ...old, commentCount: 3, comments: [{ ...old.comments[0]!, url: "https://example.com/comment" }] }))}><Text>Partial</Text></View><Text>{fix() ? "Fix selected" : ""}</Text><ReviewThreadCard summary thread={thread()} actions={actions} canReply={() => false} canResolve={() => false} canReact={() => false} now={() => 0} onFix={() => fix.set(true)} /></View>);
