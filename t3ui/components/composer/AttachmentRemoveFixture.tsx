import { mount, Text, View } from "nsh";
import { Composer } from "../Composer";
import { ConfirmDialogHost } from "../toast/ConfirmDialogHost";
import { addAttachment, applyShellEventForTest, composerDraft, createThread, draftAttachments, setComposerDraft } from "../../store";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));

applyShellEventForTest({
  kind: "snapshot",
  snapshot: { projects: [{ id: "project-1", title: "legion", workspaceRoot: "/work/legion", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-11T11:30:00Z" }], threads: [] },
});
createThread("project-1");
// The first image lands in an empty prompt (no chip); the second after text was typed (a chip the prompt references).
void addAttachment(new File([PNG], "plain.png", { type: "image/png" }));
setComposerDraft("look at this");
void addAttachment(new File([PNG], "shot.png", { type: "image/png" }));

function Fixture() {
  return (
    <View class="flex-1">
      <Composer />
      <ConfirmDialogHost />
      <Text>{`attachments:${draftAttachments().map((item) => item.name).join(",")}`}</Text>
      <Text>{`chipped:${composerDraft().includes("shot.png")}`}</Text>
    </View>
  );
}

mount(Fixture);
