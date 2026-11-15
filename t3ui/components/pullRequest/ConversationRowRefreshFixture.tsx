import { mount, signal, Text, View } from "nsh";
import { ConversationRow } from "./PullRequestSummaryTab";
import { parseActivity } from "./pullRequestDetail.logic";
import type { PullRequestDetailData } from "./pullRequestDetail.logic";
import type { PullRequestDetailModel } from "./pullRequestDetailModel";
import { conversationItems } from "./pullRequestConversation.logic";

const body = signal("Before refresh");
const item = () => conversationItems(parseActivity({ comments: [{ id: "comment", kind: "review-comment", author: null, body: body(), createdAt: "2026-01-01T00:00:00Z" }], commits: [], reviewThreads: [] }))[0]!;
const finding = signal("");
const detail = { viewer: "", capabilities: { reactions: false, editComment: false } } as PullRequestDetailData;
const model = { actions: {} } as PullRequestDetailModel;
mount(() => <View class="flex-1"><View role="button" accessibilityLabel="Refresh conversation" onPress={() => body.set("After refresh")}><Text>Refresh</Text></View><Text>{finding()}</Text><ConversationRow item={item()} detail={detail} model={model} now={() => 0} onFixFinding={(value) => finding.set(`${value.kind}:${value.kind === "comment" ? value.comment.id : "other"}`)} /></View>);
