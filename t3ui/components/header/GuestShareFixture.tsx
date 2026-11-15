import { mount, signal, Text, View } from "nsh";
import { GuestPendingMessages, GuestShareDialogHost } from "./GuestShareControls";
import { openGuestShareDialog } from "./guestShare";
import type { GuestMessage } from "./threadRelations";

const messages = signal<GuestMessage[]>([
  { id: "gm-1", text: "Can you also add tests?", status: "pending", submittedAt: "2029-12-31T10:00:00Z", attachments: [{ id: "a1", name: "log.txt", mimeType: "text/plain", type: "file", sizeBytes: 2048 }, { id: "a2", name: "shot.png", mimeType: "image/png", type: "image", sizeBytes: 70 }] },
  { id: "gm-2", text: "And update the docs", status: "pending", submittedAt: "2029-12-31T10:01:00Z", attachments: [] },
]);
const log = signal<string[]>([]);
function Fixture() {
  return (
    <View class="h-[600px] w-[700px] bg-background">
      <GuestPendingMessages
        messages={() => messages()}
        guestName={() => "Ada"}
        onResolve={async (id, decision) => { log.update((l) => [...l, `${decision} ${id}`]); messages.update((all) => all.filter((m) => m.id !== id)); }}
      />
      <View class="h-8 w-28" role="button" accessibilityLabel="Open share dialog" onPress={() => openGuestShareDialog("thread-1")}><Text>open</Text></View>
      <View testID="log">{log().map((entry) => <Text>{entry}</Text>)}</View>
      <GuestShareDialogHost />
    </View>
  );
}
mount(Fixture);
