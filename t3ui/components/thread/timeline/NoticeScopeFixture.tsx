import { mount, View } from "nsh";
import { applyShellEventForTest, applyThreadEventForTest, openThreadById, setBackendStatusForTest, setRequestBackendForTest } from "../../../store";
import { NoticeRow } from "./TimelineRows";

const parent = "environment:parent";
const now = "2026-11-14T12:00:00.000Z";
setRequestBackendForTest(() => Promise.resolve({}));
setBackendStatusForTest("connected");
applyShellEventForTest({ kind: "snapshot", snapshot: { projects: [], threads: [{ id: parent, projectId: null, title: "Parent", createdAt: now, updatedAt: now }] } });
openThreadById(parent);
applyThreadEventForTest(parent, { kind: "snapshot", projection: { messages: [], runs: [], turnItems: [], subagents: [{ id: "agent", childThreadId: "child", title: "Shield Pickups", status: "completed", result: "Finished the work", driver: "codex" }] } });

mount(() => <View><NoticeRow parentThreadId={() => parent} item={() => ({ id: "notice", type: "notification", title: "Generic notice", detail: "", status: "completed", item: { id: "notice", type: "notification", threadId: "parent", source: { kind: "subagent", childThreadId: "child" }, outcome: "completed", createdAt: now } })} expanded={() => false} onToggle={() => {}} /></View>);
