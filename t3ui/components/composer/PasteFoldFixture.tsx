// The real Composer (no environment connected) with the toasts listed, for the large-paste fold.
import { mount, Text, View } from "nsh";
import { Composer } from "../Composer";
import { applyShellEventForTest, composerDraft, createThread } from "../../store";
import { toasts } from "../toast/toastState";

applyShellEventForTest({
  kind: "snapshot",
  snapshot: { projects: [{ id: "project-1", title: "legion", workspaceRoot: "/work/legion", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-11T11:30:00Z" }], threads: [] },
});
createThread("project-1");

function Fixture() {
  return (
    <View class="flex-1">
      <Composer />
      <Text>{`draft-length:${composerDraft().length}`}</Text>
      <Text>{`toasts:${toasts().map((toast) => toast.title).join("|")}`}</Text>
    </View>
  );
}
mount(Fixture);
