import { mount, Text, View } from "nsh";
import { Composer } from "../Composer";
import { addAttachment, applyShellEventForTest, composerDraft, createThread, draftAttachments } from "../../store";

applyShellEventForTest({ kind: "snapshot", snapshot: { projects: [{ id: "project-1", title: "demo", workspaceRoot: "/work/demo", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-11T11:30:00Z" }], threads: [] } });
createThread("project-1");
void addAttachment(new File(["{}"], "package.json", { type: "application/json" }));

mount(() => <View class="flex-1"><Composer /><Text>{`attachments:${draftAttachments().length}`}</Text><Text>{`draft:${JSON.stringify(composerDraft())}`}</Text></View>);
